import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createToolchainPaths, runtimeDirectory } from "./paths.ts";
import { ToolchainStateStore, emptyToolchainState, parseToolchainState } from "./state-store.ts";

test("persists app-private state atomically and recovers from its backup", () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "pi-toolchain-state-"));
  try {
    const paths = createToolchainPaths(directory);
    const store = new ToolchainStateStore(paths);
    const state = emptyToolchainState();
    state.preferences["js.node"] = { mode: "managed" };
    state.custom["python.interpreter"] = { executable: path.join(directory, "python") };
    store.save(state);
    const updated = store.update((draft) => {
      draft.managed["node-lts"] = {
        activeVersion: "24.18.0",
        platformArch: "darwin-arm64",
        installedVersions: ["24.18.0"],
      };
    });
    assert.equal(updated.revision, 1);
    assert.equal(store.load().managed["node-lts"].activeVersion, "24.18.0");
    assert.equal(store.load().custom["python.interpreter"].executable, path.join(directory, "python"));
    writeFileSync(paths.stateFile, "{broken", "utf8");
    assert.equal(store.load().preferences["js.node"].mode, "managed");
    assert.match(readFileSync(paths.stateBackupFile, "utf8"), /js\.node/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("rejects path traversal in state and runtime paths", () => {
  const state = emptyToolchainState();
  state.managed.cpython = {
    activeVersion: "../../escape",
    platformArch: "linux-x64",
    installedVersions: ["../../escape"],
  };
  assert.throws(() => parseToolchainState(state), /activation/);
  assert.throws(
    () => runtimeDirectory(createToolchainPaths("/app-data"), "cpython", "../escape", "linux", "x64"),
    /Unsafe managed component version/,
  );
  state.managed = {};
  state.custom["python.interpreter"] = { executable: "../relative-python" };
  assert.throws(() => parseToolchainState(state), /custom tool path/);
});

test("loads schema 2 state written before custom selections were introduced", () => {
  const legacy = {
    schemaVersion: 2,
    revision: 3,
    preferences: { "js.node": { mode: "system" } },
    managed: {},
  };
  const parsed = parseToolchainState(legacy);
  assert.deepEqual(parsed.custom, {});
  assert.equal(parsed.preferences["js.node"].mode, "system");
});

test("drops retired Corepack, pnpm, and Yarn selections from schema 2 state", () => {
  const legacy = {
    schemaVersion: 2,
    revision: 4,
    preferences: {
      "js.node": { mode: "managed" },
      "js.corepack": { mode: "system" },
      "js.pnpm": { mode: "custom" },
    },
    custom: {
      "js.yarn": { executable: "/usr/local/bin/yarn" },
    },
    managed: {},
  };
  const parsed = parseToolchainState(legacy);
  assert.deepEqual(parsed.preferences, { "js.node": { mode: "managed" } });
  assert.deepEqual(parsed.custom, {});
});

test("future state is read-only and neither the state file nor runtime data is deleted on rollback", () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "pi-toolchain-future-state-"));
  try {
    const paths = createToolchainPaths(directory);
    const runtime = runtimeDirectory(paths, "node-lts", "24.18.0", process.platform, process.arch);
    mkdirSync(runtime, { recursive: true });
    writeFileSync(path.join(runtime, "sentinel"), "keep", "utf8");
    mkdirSync(paths.root, { recursive: true });
    const future = `${JSON.stringify({ schemaVersion: 99, revision: 7, preferences: {}, managed: {}, future: true })}\n`;
    writeFileSync(paths.stateFile, future, "utf8");
    writeFileSync(paths.stateBackupFile, `${JSON.stringify(emptyToolchainState())}\n`, "utf8");

    const store = new ToolchainStateStore(paths);
    assert.deepEqual(store.load().managed, {});
    assert.equal(store.isCompatibilityReadOnly(), true);
    assert.throws(
      () =>
        store.update((draft) => {
          draft.preferences["js.node"] = { mode: "managed" };
        }),
      /newer Pi Desktop/,
    );
    assert.equal(readFileSync(paths.stateFile, "utf8"), future);
    assert.equal(readFileSync(path.join(runtime, "sentinel"), "utf8"), "keep");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
