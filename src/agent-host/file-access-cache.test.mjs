import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";

const output = path.join(import.meta.dirname, "../../.artifacts/test-modules", `file-access-${process.pid}.mjs`);
mkdirSync(path.dirname(output), { recursive: true });

const sessionReaderMock = `
let calls = 0;
let releaseFirst;

export function listAllSessions() {
  calls++;
  if (calls === 1) {
    return new Promise((resolve) => {
      releaseFirst = resolve;
    });
  }
  return Promise.resolve([{ cwd: "/fresh", projectRoot: "/fresh" }]);
}

export function getSessionScanCount() {
  return calls;
}

export function releaseFirstSessionScan(sessions) {
  releaseFirst(sessions);
}
`;

await build({
  stdin: {
    contents: `
      export { getAllowedFileRoots } from "./file-access.ts";
      export {
        getAllowedRootsCache,
        invalidateAllowedRootsCache,
        setAllowedRootsWatcherHealthy,
      } from "../shared/allowed-roots.ts";
      export { getSessionScanCount, releaseFirstSessionScan } from "roots-test-control";
    `,
    resolveDir: import.meta.dirname,
    sourcefile: "file-access-cache-test-entry.ts",
    loader: "ts",
  },
  outfile: output,
  bundle: true,
  format: "esm",
  platform: "node",
  logLevel: "silent",
  plugins: [
    {
      name: "session-reader-mock",
      setup(builder) {
        builder.onResolve({ filter: /^\.\/session-reader$/ }, (args) => {
          if (!args.importer.endsWith("file-access.ts")) return null;
          return { path: "session-reader", namespace: "roots-test" };
        });
        builder.onResolve({ filter: /^roots-test-control$/ }, () => ({
          path: "session-reader",
          namespace: "roots-test",
        }));
        builder.onLoad({ filter: /.*/, namespace: "roots-test" }, () => ({
          contents: sessionReaderMock,
          loader: "js",
        }));
      },
    },
  ],
});

const {
  getAllowedFileRoots,
  getAllowedRootsCache,
  getSessionScanCount,
  invalidateAllowedRootsCache,
  releaseFirstSessionScan,
  setAllowedRootsWatcherHealthy,
} = await import(`${pathToFileURL(output).href}?v=${Date.now()}`);

test("an invalidation during a roots scan retries and never caches the stale snapshot", async () => {
  setAllowedRootsWatcherHealthy(true);
  invalidateAllowedRootsCache();

  const pendingRoots = getAllowedFileRoots();
  assert.equal(getSessionScanCount(), 1);

  invalidateAllowedRootsCache();
  releaseFirstSessionScan([{ cwd: "/stale", projectRoot: "/stale" }]);

  const roots = await pendingRoots;
  assert.equal(getSessionScanCount(), 2);
  assert.equal(roots.has("/fresh"), true);
  assert.equal(roots.has("/stale"), false);
  assert.equal(getAllowedRootsCache().roots.has("/fresh"), true);
  assert.equal(getAllowedRootsCache().roots.has("/stale"), false);

  setAllowedRootsWatcherHealthy(false);
  invalidateAllowedRootsCache();
});
