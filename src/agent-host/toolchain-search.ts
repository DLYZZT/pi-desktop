import fs from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline";
import {
  createFindToolDefinition,
  createGrepToolDefinition,
  DEFAULT_MAX_BYTES,
  formatSize,
  truncateHead,
  truncateLine,
  type GrepToolDetails,
} from "@earendil-works/pi-coding-agent";
import type { ToolExecutionContext } from "../shared/toolchains/types.ts";
import { toolchainRuntime, type ToolchainRuntime } from "./toolchain-runtime.ts";

const DEFAULT_RESULT_LIMIT = 100;
const SEARCH_OUTPUT_LIMIT = 2 * 1024 * 1024;

/** The Desktop-owned equivalent of the upstream search runtime contract. */
export interface SearchToolRuntime {
  rgPath?: string;
  fdPath?: string;
  allowUpstreamDownload: false;
}

interface RgEvent {
  type?: string;
  data?: {
    path?: { text?: string };
    lines?: { text?: string };
    line_number?: number;
  };
}

interface RgResult {
  events: RgEvent[];
  matchLimitReached: boolean;
}

export function searchToolRuntimeFromContext(context: ToolExecutionContext): SearchToolRuntime {
  return {
    rgPath: context.commands["search.rg"]?.executable,
    fdPath: context.commands["search.fd"]?.executable,
    allowUpstreamDownload: false,
  };
}

function resolveSearchPath(cwd: string, requested: string | undefined): string {
  const value = requested?.trim() || ".";
  return path.isAbsolute(value) ? path.normalize(value) : path.resolve(cwd, value);
}

async function pathExists(value: string): Promise<boolean> {
  try {
    await fs.access(value);
    return true;
  } catch {
    return false;
  }
}

async function isInsideGitRepository(start: string): Promise<boolean> {
  for (let current = start; ; current = path.dirname(current)) {
    if (await pathExists(path.join(current, ".git"))) return true;
    const parent = path.dirname(current);
    if (parent === current) return false;
  }
}

function runRg(
  args: string[],
  cwd: string,
  context: ToolExecutionContext,
  runtime: ToolchainRuntime,
  signal: AbortSignal | undefined,
  limit: number,
): Promise<RgResult> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error("Operation aborted"));
      return;
    }
    let settled = false;
    let aborted = false;
    let matchLimitReached = false;
    let matchCount = 0;
    let stderr = "";
    const events: RgEvent[] = [];
    const child = runtime.spawnFromContext("search.rg", args, context, {
      cwd,
      stdio: "pipe",
      windowsHide: true,
    });
    if (!child.stdout) {
      child.kill();
      reject(new Error("ripgrep stdout is unavailable"));
      return;
    }
    const lines = createInterface({ input: child.stdout });
    const cleanup = (): void => {
      lines.close();
      signal?.removeEventListener("abort", onAbort);
    };
    const finish = (operation: () => void): void => {
      if (settled) return;
      settled = true;
      cleanup();
      operation();
    };
    const stop = (): void => {
      if (!child.killed) child.kill();
    };
    const onAbort = (): void => {
      aborted = true;
      stop();
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    child.stderr?.on("data", (chunk: Buffer | string) => {
      if (stderr.length < SEARCH_OUTPUT_LIMIT) stderr += chunk.toString();
      if (stderr.length >= SEARCH_OUTPUT_LIMIT) stop();
    });
    lines.on("line", (line) => {
      if (!line.trim() || matchLimitReached) return;
      let event: RgEvent;
      try {
        event = JSON.parse(line) as RgEvent;
      } catch {
        return;
      }
      if (event.type !== "match" && event.type !== "context") return;
      events.push(event);
      if (event.type === "match") {
        matchCount += 1;
        if (matchCount >= limit) {
          matchLimitReached = true;
          stop();
        }
      }
    });
    child.once("error", (error) => finish(() => reject(new Error(`Failed to run ripgrep: ${error.message}`))));
    child.once("close", (code) => {
      if (aborted) {
        finish(() => reject(new Error("Operation aborted")));
        return;
      }
      if (!matchLimitReached && code !== 0 && code !== 1) {
        finish(() => reject(new Error(stderr.trim() || `ripgrep exited with code ${String(code)}`)));
        return;
      }
      finish(() => resolve({ events, matchLimitReached }));
    });
  });
}

function formatRgEvents(
  events: readonly RgEvent[],
  searchPath: string,
  directory: boolean,
): {
  output: string;
  linesTruncated: boolean;
} {
  const output: string[] = [];
  let linesTruncated = false;
  for (const event of events) {
    const file = event.data?.path?.text;
    const lineNumber = event.data?.line_number;
    if (!file || typeof lineNumber !== "number") continue;
    const relative = directory ? path.relative(searchPath, file) : path.basename(file);
    const label = (relative && !relative.startsWith("..") ? relative : path.basename(file)).replace(/\\/g, "/");
    const raw = (event.data?.lines?.text ?? "").replace(/\r\n/g, "\n").replace(/\r/g, "").replace(/\n$/, "");
    const { text, wasTruncated } = truncateLine(raw);
    linesTruncated ||= wasTruncated;
    output.push(
      `${label}${event.type === "match" ? ":" : "-"}${lineNumber}${event.type === "match" ? ":" : "-"} ${text}`,
    );
  }
  return { output: output.join("\n"), linesTruncated };
}

export function createDesktopSearchToolDefinitions(
  cwd: string,
  context: ToolExecutionContext,
  runtime: ToolchainRuntime = toolchainRuntime,
): [ReturnType<typeof createGrepToolDefinition>, ReturnType<typeof createFindToolDefinition>] {
  const grep = createGrepToolDefinition(cwd);
  grep.execute = async (_toolCallId, input, signal) => {
    const searchPath = resolveSearchPath(cwd, input.path);
    let directory: boolean;
    try {
      directory = (await fs.stat(searchPath)).isDirectory();
    } catch {
      throw new Error(`Path not found: ${searchPath}`);
    }
    const effectiveLimit = Math.max(1, input.limit ?? DEFAULT_RESULT_LIMIT);
    const args = ["--json", "--line-number", "--color=never", "--hidden", "--max-columns", "2000"];
    if (input.ignoreCase) args.push("--ignore-case");
    if (input.literal) args.push("--fixed-strings");
    if (input.glob) args.push("--glob", input.glob);
    if (input.context && input.context > 0) args.push("--context", String(Math.floor(input.context)));
    args.push("--", input.pattern, searchPath);

    const result = await runRg(args, cwd, context, runtime, signal, effectiveLimit);
    const formatted = formatRgEvents(result.events, searchPath, directory);
    if (!formatted.output) return { content: [{ type: "text", text: "No matches found" }], details: undefined };

    const truncation = truncateHead(formatted.output, { maxLines: Number.MAX_SAFE_INTEGER });
    const details: GrepToolDetails = {};
    const notices: string[] = [];
    if (result.matchLimitReached) {
      details.matchLimitReached = effectiveLimit;
      notices.push(
        `${effectiveLimit} matches limit reached. Use limit=${effectiveLimit * 2} for more, or refine pattern`,
      );
    }
    if (truncation.truncated) {
      details.truncation = truncation;
      notices.push(`${formatSize(DEFAULT_MAX_BYTES)} limit reached`);
    }
    if (formatted.linesTruncated) {
      details.linesTruncated = true;
      notices.push("Some long lines were truncated. Use read to inspect the full line");
    }
    const text = `${truncation.content}${notices.length > 0 ? `\n\n[${notices.join(". ")}]` : ""}`;
    return { content: [{ type: "text", text }], details: Object.keys(details).length > 0 ? details : undefined };
  };

  const find = createFindToolDefinition(cwd, {
    operations: {
      exists: pathExists,
      async glob(pattern, searchPath, options) {
        const args = [
          "--glob",
          "--color=never",
          "--hidden",
          "--absolute-path",
          "--print0",
          "--exclude",
          ".git",
          "--exclude",
          "node_modules",
        ];
        if (!(await isInsideGitRepository(searchPath))) args.push("--no-require-git");
        args.push("--max-results", String(Math.max(1, options.limit)));
        let effectivePattern = pattern;
        if (pattern.includes("/")) {
          args.push("--full-path");
          if (!pattern.startsWith("/") && !pattern.startsWith("**/") && pattern !== "**") {
            effectivePattern = `**/${pattern}`;
          }
        }
        args.push("--", effectivePattern, searchPath);
        const result = await runtime.execFromContext("search.fd", args, context, {
          cwd,
          maxBuffer: SEARCH_OUTPUT_LIMIT,
        });
        return result.stdout
          .split("\0")
          .map((entry) => entry.trim())
          .filter(Boolean);
      },
    },
  });

  return [grep, find];
}
