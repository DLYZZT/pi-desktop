#!/usr/bin/env node

import { rm } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { performance } from "node:perf_hooks";
import { mkdirSync, mkdtempSync, statSync } from "node:fs";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { build } from "esbuild";

const root = path.resolve(import.meta.dirname, "..");
const artifactsDirectory = path.join(root, ".artifacts");
mkdirSync(artifactsDirectory, { recursive: true });
const temporaryDirectory = mkdtempSync(path.join(artifactsDirectory, "session-bench-"));

function round(value) {
  return Math.round(value * 10) / 10;
}

function quantile(sorted, fraction) {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * fraction));
  return sorted[index];
}

async function measure(operation) {
  const startedAt = performance.now();
  const value = await operation();
  return { value, milliseconds: round(performance.now() - startedAt) };
}

try {
  const bundledReader = path.join(temporaryDirectory, "session-reader.mjs");
  await build({
    stdin: {
      contents: [
        'export { buildSessionContext, buildSessionInfoFromManager } from "./src/agent-host/session-reader.ts";',
        'export { buildHistoryRevision, buildSessionHistoryPage } from "./src/agent-host/session-history.ts";',
        'export { projectSessionTreeForResponse } from "./src/agent-host/project-tree.ts";',
        'export { SessionIndex } from "./src/agent-host/session-index.ts";',
      ].join("\n"),
      resolveDir: root,
      sourcefile: "session-reader-benchmark-entry.ts",
      loader: "ts",
    },
    outfile: bundledReader,
    bundle: true,
    format: "esm",
    platform: "node",
    packages: "external",
    logLevel: "silent",
  });
  const {
    buildHistoryRevision,
    buildSessionContext,
    buildSessionHistoryPage,
    buildSessionInfoFromManager,
    projectSessionTreeForResponse,
    SessionIndex,
  } = await import(pathToFileURL(bundledReader).href);

  const coldList = await measure(() => SessionManager.listAll());
  const warmList = await measure(() => SessionManager.listAll());
  const sessions = warmList.value;
  const index = new SessionIndex();
  const coldIndex = await measure(async () => {
    await index.refreshAll();
    return index.getAll();
  });
  const warmIndex = await measure(async () => {
    await index.refreshAll();
    return index.getAll();
  });
  const largest = sessions.reduce((candidate, session) => {
    const bytes = statSync(session.path).size;
    return !candidate || bytes > candidate.bytes ? { session, bytes } : candidate;
  }, null);

  if (!largest) {
    console.log(
      JSON.stringify(
        {
          sessionFiles: 0,
          listAllMs: [coldList.milliseconds, warmList.milliseconds],
          desktopIndexMs: [coldIndex.milliseconds, warmIndex.milliseconds],
          desktopIndexWarmMetrics: index.getMetrics(),
        },
        null,
        2,
      ),
    );
    process.exitCode = 0;
  } else {
    const opened = await measure(() => SessionManager.open(largest.session.path));
    const entries = opened.value.getEntries();
    const context = await measure(() => buildSessionContext(entries, opened.value.getLeafId()));
    const entryBytes = entries.map((entry) => Buffer.byteLength(JSON.stringify(entry), "utf8")).sort((a, b) => a - b);
    const tail120Bytes = entries
      .slice(-120)
      .reduce((total, entry) => total + Buffer.byteLength(JSON.stringify(entry), "utf8"), 0);
    const responseBytes = Buffer.byteLength(JSON.stringify({ context: context.value }), "utf8");
    const paged = await measure(() =>
      buildSessionHistoryPage({
        entries,
        leafId: opened.value.getLeafId(),
        historyWindow: { maxTurns: 20, maxBytes: 1024 * 1024 },
        historyRevision: buildHistoryRevision(largest.session.path, largest.session.id),
      }),
    );
    const info = await buildSessionInfoFromManager(largest.session.path, opened.value, entries);
    const projectedTree = projectSessionTreeForResponse(opened.value.getTree());
    const pagedResponseBytes = Buffer.byteLength(
      JSON.stringify({
        sessionId: largest.session.id,
        filePath: largest.session.path,
        info,
        leafId: opened.value.getLeafId(),
        tree: projectedTree,
        context: paged.value,
      }),
      "utf8",
    );

    console.log(
      JSON.stringify(
        {
          sessionFiles: sessions.length,
          uniqueCwds: new Set(sessions.map((session) => session.cwd).filter(Boolean)).size,
          totalFileBytes: sessions.reduce((total, session) => total + statSync(session.path).size, 0),
          listAllMs: [coldList.milliseconds, warmList.milliseconds],
          desktopIndexMs: [coldIndex.milliseconds, warmIndex.milliseconds],
          desktopIndexWarmMetrics: index.getMetrics(),
          largestSession: {
            fileBytes: largest.bytes,
            entries: entries.length,
            messages: context.value.messages.length,
            openMs: opened.milliseconds,
            contextMs: context.milliseconds,
            responseBytes,
            pagedContextMs: paged.milliseconds,
            pagedResponseBytes,
            pagedMessages: paged.value.loadedMessages,
            hasOlder: paged.value.truncatedBefore,
            entryBytes: {
              p50: quantile(entryBytes, 0.5),
              p90: quantile(entryBytes, 0.9),
              p95: quantile(entryBytes, 0.95),
              p99: quantile(entryBytes, 0.99),
              max: entryBytes.at(-1) ?? 0,
            },
            tail120Bytes,
          },
        },
        null,
        2,
      ),
    );
  }
} finally {
  await rm(temporaryDirectory, { recursive: true, force: true });
}
