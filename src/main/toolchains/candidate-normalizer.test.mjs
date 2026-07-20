import assert from "node:assert/strict";
import test from "node:test";

import {
  candidateIdentity,
  isToolPathInside,
  normalizeAndDedupeCandidates,
  normalizePathEntries,
  normalizeToolPath,
  redactToolPath,
  stableSortToolCandidates,
  toolPathComparisonKey,
} from "./candidate-normalizer.ts";

function candidate(overrides = {}) {
  return {
    id: "candidate",
    capability: "js.node",
    provider: "system",
    discovery: "path",
    executable: "/usr/local/bin/node",
    binDir: "/usr/local/bin",
    health: "healthy",
    rank: 0,
    ...overrides,
  };
}

test("normalizes Windows paths, drive letters, quotes, and comparison case", () => {
  assert.equal(normalizeToolPath('"c:/Program Files/Nodejs/node.exe"', "win32"), "C:\\Program Files\\Nodejs\\node.exe");
  assert.equal(
    toolPathComparisonKey("C:\\TOOLS\\NODE.EXE", "win32"),
    toolPathComparisonKey("c:/tools/node.exe", "win32"),
  );
  assert.equal(normalizeToolPath("\\\\server\\share\\tools\\", "win32"), "\\\\server\\share\\tools");
});

test("normalizes PATH entries without accepting relative or duplicate paths", () => {
  assert.deepEqual(normalizePathEntries("C:\\Tools;C:/tools;;relative;D:\\开发 工具", "win32"), [
    "C:\\Tools",
    "D:\\开发 工具",
  ]);
  assert.deepEqual(normalizePathEntries("/usr/bin:/usr/bin:relative:/opt/工具 bin", "linux"), [
    "/usr/bin",
    "/opt/工具 bin",
  ]);
});

test("handles Windows UNC containment without prefix confusion", () => {
  assert.equal(isToolPathInside("\\\\server\\share\\tools\\node.exe", "\\\\server\\share\\tools", "win32"), true);
  assert.equal(isToolPathInside("\\\\server\\share2\\node.exe", "\\\\server\\share", "win32"), false);
  assert.equal(isToolPathInside("C:\\toolbox\\node.exe", "C:\\tool", "win32"), false);
});

test("redacts the longest matching root and preserves Unicode relative paths", () => {
  assert.equal(
    redactToolPath(
      "/Users/李雷/Library/Application Support/Pi/toolchains/runtimes/node",
      [
        { path: "/Users/李雷", label: "$HOME" },
        { path: "/Users/李雷/Library/Application Support/Pi", label: "<userData>" },
      ],
      "darwin",
    ),
    "<userData>/toolchains/runtimes/node",
  );
});

test("deduplicates symlinked candidates by resolved executable while retaining the preferred source", () => {
  const system = candidate({
    id: "system-path",
    executable: "/opt/homebrew/bin/node",
    pathOrder: 0,
  });
  const known = candidate({
    id: "known-location",
    executable: "/opt/homebrew/opt/node@22/bin/node",
    discovery: "known-location",
    rank: 50,
  });
  const resolveRealPath = () => "/opt/homebrew/Cellar/node@22/22.22.0/bin/node";
  const result = normalizeAndDedupeCandidates([known, system], {
    platform: "darwin",
    resolveRealPath,
  });

  assert.deepEqual(
    result.map((entry) => entry.id),
    ["system-path"],
  );
  assert.equal(
    candidateIdentity(system, { platform: "darwin", resolveRealPath }),
    candidateIdentity(known, {
      platform: "darwin",
      resolveRealPath,
    }),
  );
});

test("sorts healthy project, custom, system, bundled, managed, and legacy candidates stably", () => {
  const result = stableSortToolCandidates([
    candidate({ id: "legacy", provider: "legacy-upstream-managed" }),
    candidate({ id: "managed", provider: "managed" }),
    candidate({ id: "bundled", provider: "bundled" }),
    candidate({ id: "system-later", provider: "system", pathOrder: 2 }),
    candidate({ id: "system-first", provider: "system", pathOrder: 0 }),
    candidate({ id: "custom", provider: "custom" }),
    candidate({ id: "project", provider: "project" }),
    candidate({ id: "broken-project", provider: "project", health: "broken" }),
  ]);

  assert.deepEqual(
    result.map((entry) => entry.id),
    ["project", "custom", "system-first", "system-later", "bundled", "managed", "legacy", "broken-project"],
  );
});
