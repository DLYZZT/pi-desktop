import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { boundedDirectoryBytes, retainedManagedVersions, ToolchainManager } from "./manager.ts";
import { createToolchainPaths, runtimeDirectory } from "./paths.ts";
import { ToolchainStateStore } from "./state-store.ts";
import { ToolchainError } from "../../shared/toolchains/errors.ts";
import { TOOL_CAPABILITY_IDS } from "../../shared/toolchains/types.ts";

const fileSystem = {
  isFile: () => true,
  isDirectory: () => true,
  readDirectoryNames: () => [],
  realpath: (filePath) => filePath.replace("/usr/local/bin/node", "/opt/node/bin/node"),
};

function seed(capability, executable, rank = 1, pathOrder) {
  return {
    capability,
    provider: "system",
    discovery: "test",
    executable,
    argvPrefix: [],
    binDir: executable.slice(0, executable.lastIndexOf("/")),
    rank,
    pathOrder,
  };
}

function candidate(source, overrides = {}) {
  return {
    id: `${source.capability}:${source.executable}:${overrides.id ?? "candidate"}`,
    capability: source.capability,
    provider: source.provider,
    discovery: source.discovery,
    executable: source.executable,
    argvPrefix: source.argvPrefix,
    binDir: source.binDir,
    health: "healthy",
    rank: source.rank,
    pathOrder: source.pathOrder,
    ...overrides,
  };
}

test("builds a redacted, stable public inventory and selects only healthy candidates", async () => {
  const node = seed("js.node", "/Users/李/.nvm/versions/node/v22/bin/node", 2, 1);
  const rg = seed("search.rg", "/usr/bin/rg", 1, 0);
  const manager = new ToolchainManager({
    platform: "darwin",
    arch: "arm64",
    env: { PATH: "/usr/bin" },
    homeDir: "/Users/李",
    userDataRoot: "/Users/李/Library/Application Support/Pi",
    fileSystem,
    registry: {
      async collect() {
        return [node, rg];
      },
    },
    probe: async (source) => {
      if (source.capability === "js.node") {
        return [
          candidate(source, { version: "22.19.0" }),
          candidate(
            { ...source, capability: "js.npm" },
            {
              id: "npm",
              health: "incomplete",
              reasonCode: "TOOLCHAIN_INCOMPLETE",
            },
          ),
        ];
      }
      return [candidate(source, { version: "14.1.0" })];
    },
    now: () => new Date("2026-07-17T12:00:00.000Z"),
  });

  assert.equal(manager.getSnapshot().revision, 0);
  assert.equal(manager.getPublicState().coreReady, false);
  const snapshot = await manager.initialize();
  assert.equal(snapshot.revision, 1);
  assert.equal(snapshot.publicState.coreReady, true);
  assert.equal(snapshot.publicState.lastScanAt, "2026-07-17T12:00:00.000Z");
  assert.equal(snapshot.defaults["js.node"].executable, node.executable);
  assert.equal(snapshot.defaults["js.npm"], undefined);
  assert.equal(snapshot.publicState.capabilities["js.node"].pathLabel, "~/.nvm/versions/node/v22/bin/node");
  assert.equal(snapshot.publicState.capabilities["js.npm"].health, "incomplete");
  assert.equal(snapshot.publicState.capabilities["python.interpreter"].health, "missing");
  assert.equal(snapshot.publicState.capabilities["python.interpreter"].reasonCode, "TOOLCHAIN_PYTHON_REQUIRED");
  assert.equal(Object.keys(snapshot.publicState.capabilities).length, TOOL_CAPABILITY_IDS.length);
});

test("coalesces concurrent rescans and advances one immutable inventory revision", async () => {
  let collections = 0;
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const source = seed("network.curl", "/usr/bin/curl");
  const manager = new ToolchainManager({
    platform: "linux",
    arch: "x64",
    fileSystem,
    registry: {
      async collect() {
        collections += 1;
        await gate;
        return [source];
      },
    },
    probe: async (value) => [candidate(value, { version: "8.0.0" })],
  });

  const first = manager.rescan();
  const second = manager.rescan();
  assert.equal(first, second);
  release();
  const snapshot = await first;
  assert.equal(collections, 1);
  assert.equal(snapshot.revision, 1);
});

test("auto switches from managed to a newly installed system tool while an explicit managed preference stays pinned", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-toolchain-auto-switch-"));
  try {
    let systemInstalled = false;
    const managedNode = {
      ...seed("js.node", "/managed/node/bin/node", 1),
      provider: "managed",
      componentId: "node-lts",
      componentRoot: "/managed/node",
    };
    const systemNode = seed("js.node", "/usr/local/bin/node", 1, 0);
    const manager = new ToolchainManager({
      platform: "linux",
      arch: "x64",
      userDataRoot: root,
      fileSystem,
      registry: {
        async collect() {
          return systemInstalled ? [managedNode, systemNode] : [managedNode];
        },
      },
      probe: async (source) => [candidate(source, { version: "24.18.0" })],
    });

    let snapshot = await manager.initialize();
    assert.equal(snapshot.defaults["js.node"].provider, "managed");

    systemInstalled = true;
    snapshot = await manager.rescan();
    assert.equal(snapshot.defaults["js.node"].provider, "system");
    assert.equal(snapshot.publicState.capabilities["js.node"].preference, "auto");

    await manager.performAction({ action: "set-preference", capability: "js.node", preference: "managed" });
    assert.equal(manager.getSnapshot().defaults["js.node"].provider, "managed");
    assert.equal(manager.getPublicState().capabilities["js.node"].preference, "managed");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("keeps a managed Bun package cache inside app-private toolchain data", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-toolchain-bun-env-"));
  try {
    const bun = {
      ...seed("js.bun", "/managed/bun/bin/bun", 1),
      provider: "managed",
      componentId: "bun",
      componentRoot: "/managed/bun",
    };
    const manager = new ToolchainManager({
      platform: "linux",
      arch: "x64",
      userDataRoot: root,
      fileSystem,
      registry: {
        async collect() {
          return [bun];
        },
      },
      probe: async (source) => [
        candidate(source, {
          version: "1.3.14",
          componentId: source.componentId,
          componentRoot: source.componentRoot,
        }),
      ],
    });
    const snapshot = await manager.initialize();
    assert.equal(snapshot.defaults["js.bun"].envPatch.BUN_INSTALL_CACHE_DIR, createToolchainPaths(root).caches.bun);
    assert.equal(snapshot.defaults["js.bun"].envPatch.BUN_INSTALL, undefined);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("an invalid packaged catalog fails closed without preventing offline system discovery", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-invalid-catalog-"));
  try {
    const catalogPath = path.join(root, "runtime-catalog.json");
    fs.writeFileSync(catalogPath, "{not-json", "utf8");
    const curl = seed("network.curl", "/usr/bin/curl");
    const manager = new ToolchainManager({
      platform: "linux",
      arch: "x64",
      userDataRoot: root,
      catalogPath,
      fileSystem,
      registry: {
        async collect() {
          return [curl];
        },
      },
      probe: async (source) => [candidate(source, { version: "8.0.0" })],
    });
    const snapshot = await manager.initialize();
    assert.equal(snapshot.publicState.coreReady, true);
    assert.equal(snapshot.publicState.capabilities["network.curl"].health, "healthy");
    assert.equal(snapshot.publicState.lastErrorCode, "TOOLCHAIN_INVALID_CATALOG");
    await assert.rejects(
      manager.performAction({ action: "install-component", componentId: "node-lts" }),
      (error) => error?.code === "TOOLCHAIN_INVALID_CATALOG",
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("deduplicates shims by the probed real executable while preserving PATH priority", async () => {
  const pathNode = seed("js.node", "/usr/local/bin/node", 100, 0);
  const knownNode = seed("js.node", "/opt/node/bin/node", 1_000);
  const manager = new ToolchainManager({
    platform: "linux",
    arch: "x64",
    fileSystem,
    registry: {
      async collect() {
        return [pathNode, knownNode];
      },
    },
    probe: async (source) => [candidate(source, { version: "22.19.0" })],
  });

  const snapshot = await manager.initialize();
  assert.equal(snapshot.candidates.length, 1);
  assert.equal(snapshot.candidates[0].executable, pathNode.executable);
});

test("resolves compatible coupled Node and Python distributions per project intent", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-toolchain-resolution-"));
  try {
    fs.mkdirSync(path.join(root, ".git"));
    fs.writeFileSync(
      path.join(root, "package.json"),
      JSON.stringify({ engines: { node: ">=24 <25" }, packageManager: "npm@11.0.0" }),
    );
    fs.writeFileSync(path.join(root, "pyproject.toml"), '[project]\nrequires-python = ">=3.14,<3.15"\n');

    const node22 = { ...seed("js.node", "/system/node22/bin/node", 1), componentRoot: "/system/node22" };
    const node24 = {
      ...seed("js.node", "/managed/node24/bin/node", 2),
      provider: "managed",
      componentRoot: "/managed/node24",
    };
    const python311 = seed("python.interpreter", "/system/python311/bin/python3", 1);
    const python314 = {
      ...seed("python.interpreter", "/managed/python314/bin/python3", 2),
      provider: "managed",
      componentRoot: "/managed/python314",
    };
    const uv = seed("python.uv", "/system/bin/uv", 1);
    const manager = new ToolchainManager({
      platform: "linux",
      arch: "x64",
      env: { PATH: "/system/bin" },
      fileSystem,
      registry: {
        async collect() {
          return [node22, node24, python311, python314, uv];
        },
      },
      probe: async (source) => {
        if (source.capability === "js.node") {
          const version = source.provider === "managed" ? "24.18.0" : "22.19.0";
          return [
            candidate(source, { version, componentRoot: source.componentRoot }),
            candidate(
              { ...source, capability: "js.npm" },
              { version: "11.0.0", componentRoot: source.componentRoot, argvPrefix: ["npm-cli.js"] },
            ),
            candidate(
              { ...source, capability: "js.npx" },
              { version: "11.0.0", componentRoot: source.componentRoot, argvPrefix: ["npx-cli.js"] },
            ),
          ];
        }
        if (source.capability === "python.interpreter") {
          return [candidate(source, { version: source.provider === "managed" ? "3.14.6" : "3.11.9" })];
        }
        return [candidate(source, { version: "0.11.29" })];
      },
    });
    await manager.initialize();

    const project = await manager.resolveForProject(root, { intent: "agent-shell", trusted: false });
    assert.equal(project.commands["js.node"].provider, "managed");
    assert.equal(project.commands["js.node"].version, "24.18.0");
    assert.equal(project.commands["js.npm"].componentRoot, project.commands["js.node"].componentRoot);
    assert.equal(project.commands["js.npx"].componentRoot, project.commands["js.node"].componentRoot);
    assert.equal(project.commands["python.interpreter"].version, "3.14.6");
    assert.equal(project.commands["python.uv"].envPatch.UV_PYTHON, "/managed/python314/bin/python3");
    assert.ok(project.summary.includes("Project package manager: npm"));

    const publicProject = await manager.getPublicStateForProject(root);
    assert.equal(publicProject.capabilities["js.node"].provider, "managed");
    assert.equal(publicProject.capabilities["js.node"].version, "24.18.0");
    assert.equal(publicProject.capabilities["python.interpreter"].provider, "managed");
    assert.ok(publicProject.projectSummary.includes("Project package manager: npm"));

    const installer = await manager.resolveForProject(root, { intent: "plugin-install", trusted: false });
    assert.equal(installer.commands["js.node"].provider, "system");
    assert.equal(installer.commands["js.node"].version, "22.19.0");
    assert.notEqual(installer.requirementsHash, project.requirementsHash);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("uses a verified legacy npmCommand only for plugin compatibility without mutating the setting", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-legacy-npm-resolution-"));
  try {
    const node = { ...seed("js.node", "/system/node/bin/node"), componentRoot: "/system/node" };
    const legacyNpm = {
      ...seed("js.npm", "/home/user/.local/bin/mise"),
      provider: "custom",
      discovery: "legacy-npm-command",
      argvPrefix: ["exec", "node@22", "--", "npm"],
    };
    const manager = new ToolchainManager({
      platform: "linux",
      arch: "x64",
      fileSystem,
      registry: {
        async collect() {
          return [node, legacyNpm];
        },
      },
      probe: async (source) => {
        if (source.capability === "js.node") {
          return [
            candidate(source, { version: "24.18.0", componentRoot: source.componentRoot }),
            candidate(
              { ...source, capability: "js.npm" },
              { version: "11.0.0", componentRoot: source.componentRoot, argvPrefix: ["npm-cli.js"] },
            ),
            candidate(
              { ...source, capability: "js.npx" },
              { version: "11.0.0", componentRoot: source.componentRoot, argvPrefix: ["npx-cli.js"] },
            ),
          ];
        }
        return [candidate(source, { version: "10.9.3" })];
      },
    });
    await manager.initialize();

    const normal = await manager.resolveForProject(root, { intent: "project-command" });
    assert.equal(normal.commands["js.npm"].executable, node.executable);
    assert.deepEqual(normal.commands["js.npm"].argvPrefix, ["npm-cli.js"]);
    const plugins = await manager.resolveForProject(root, { intent: "plugin-install" });
    assert.equal(plugins.commands["js.npm"].executable, legacyNpm.executable);
    assert.deepEqual(plugins.commands["js.npm"].argvPrefix, legacyNpm.argvPrefix);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("probes and selects a project Python environment only after trust", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-project-python-resolution-"));
  try {
    fs.mkdirSync(path.join(root, ".git"));
    const environment = path.join(root, ".venv");
    const bin = path.join(environment, "bin");
    fs.mkdirSync(bin, { recursive: true });
    const projectPython = path.join(bin, "python3");
    fs.symlinkSync(process.execPath, projectPython);
    const systemPython = seed("python.interpreter", "/system/bin/python3", 1);
    let projectProbes = 0;
    const manager = new ToolchainManager({
      platform: "linux",
      arch: "x64",
      env: { PATH: "/system/bin" },
      fileSystem,
      registry: {
        async collect() {
          return [systemPython];
        },
      },
      probe: async (source) => {
        if (source.provider === "project") {
          projectProbes += 1;
          return [candidate(source, { executable: projectPython, version: "3.14.6" })];
        }
        return [candidate(source, { version: "3.11.9" })];
      },
    });
    await manager.initialize();

    const untrusted = await manager.resolveForProject(root, { intent: "agent-shell", trusted: false });
    assert.equal(untrusted.commands["python.interpreter"].provider, "system");
    assert.equal(projectProbes, 0);
    assert.ok(untrusted.summary.includes("Project Python environment: blocked until the project is trusted"));

    const trusted = await manager.resolveForProject(root, { intent: "agent-shell", trusted: true });
    assert.equal(projectProbes, 1);
    assert.equal(trusted.commands["python.interpreter"].provider, "project");
    assert.equal(trusted.commands["python.interpreter"].executable, projectPython);
    assert.equal(trusted.commands["python.interpreter"].envPatch.VIRTUAL_ENV, environment);
    assert.ok(trusted.summary.includes("Project Python environment: active"));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("retains one rollback per component and parallel CPython minors", () => {
  assert.deepEqual(retainedManagedVersions("node-lts", "24.0.0", ["22.0.0", "23.0.0", "24.0.0"]), ["24.0.0", "23.0.0"]);
  assert.deepEqual(
    retainedManagedVersions("cpython", "3.14.6+2", ["3.10.9+1", "3.11.8+1", "3.11.9+1", "3.14.5+1", "3.14.6+2"]),
    ["3.14.6+2", "3.14.5+1", "3.11.9+1", "3.10.9+1"],
  );
});

test("measures private tool directories without following symlinks or returning partial oversized totals", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-toolchain-size-"));
  try {
    fs.mkdirSync(path.join(root, "nested"));
    fs.writeFileSync(path.join(root, "first.bin"), Buffer.alloc(7));
    fs.writeFileSync(path.join(root, "nested", "second.bin"), Buffer.alloc(11));
    fs.symlinkSync(
      path.join(root, "nested"),
      path.join(root, "linked"),
      process.platform === "win32" ? "junction" : "dir",
    );
    assert.equal(boundedDirectoryBytes(root), 18);
    assert.equal(boundedDirectoryBytes(root, 2), undefined);
    assert.equal(boundedDirectoryBytes(path.join(root, "missing")), 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("probes Main-selected custom executables before persisting private paths", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-custom-tool-"));
  try {
    const executable = path.join(root, "bin", "python3");
    fs.mkdirSync(path.dirname(executable), { recursive: true });
    fs.writeFileSync(executable, "test");
    let healthy = true;
    const manager = new ToolchainManager({
      platform: "linux",
      arch: "x64",
      userDataRoot: root,
      homeDir: root,
      fileSystem,
      registry: {
        async collect() {
          return [];
        },
      },
      probe: async (source) => [
        candidate(source, {
          version: "3.14.6",
          health: healthy ? "healthy" : "broken",
          reasonCode: healthy ? undefined : "TOOLCHAIN_BROKEN",
        }),
      ],
    });
    await manager.initialize();
    const selected = await manager.registerCustomTool("python.interpreter", executable);
    assert.equal(selected.capabilities["python.interpreter"].provider, "custom");
    assert.equal(selected.capabilities["python.interpreter"].preference, "custom");
    assert.equal(selected.capabilities["python.interpreter"].pathLabel.includes(executable), false);
    assert.equal(
      new ToolchainStateStore(createToolchainPaths(root)).load().custom["python.interpreter"].executable,
      executable,
    );

    healthy = false;
    await assert.rejects(
      manager.registerCustomTool("python.interpreter", path.join(root, "bin", "broken-python")),
      (error) => error?.code === "TOOLCHAIN_INVALID_SELECTION",
    );
    assert.equal(
      new ToolchainStateStore(createToolchainPaths(root)).load().custom["python.interpreter"].executable,
      executable,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("prunes superseded runtime directories only during startup before Host sessions exist", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-runtime-pruning-"));
  try {
    const paths = createToolchainPaths(root);
    const store = new ToolchainStateStore(paths);
    const versions = ["22.0.0", "23.0.0", "24.0.0"];
    for (const version of versions) {
      fs.mkdirSync(runtimeDirectory(paths, "node-lts", version, process.platform, process.arch), { recursive: true });
    }
    store.update((draft) => {
      draft.managed["node-lts"] = {
        activeVersion: "24.0.0",
        platformArch: `${process.platform}-${process.arch}`,
        installedVersions: versions,
      };
    });
    const manager = new ToolchainManager({
      userDataRoot: root,
      fileSystem,
      registry: {
        async collect() {
          return [];
        },
      },
      probe: async () => [],
    });
    await manager.initialize();
    assert.equal(fs.existsSync(runtimeDirectory(paths, "node-lts", "22.0.0", process.platform, process.arch)), false);
    assert.equal(fs.existsSync(runtimeDirectory(paths, "node-lts", "23.0.0", process.platform, process.arch)), true);
    assert.equal(fs.existsSync(runtimeDirectory(paths, "node-lts", "24.0.0", process.platform, process.arch)), true);
    assert.deepEqual(store.load().managed["node-lts"].installedVersions, ["24.0.0", "23.0.0"]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("refuses to remove managed runtimes while Agent commands may still be using them", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-runtime-in-use-"));
  try {
    const paths = createToolchainPaths(root);
    const runtime = runtimeDirectory(paths, "node-lts", "24.18.0", process.platform, process.arch);
    fs.mkdirSync(runtime, { recursive: true });
    const store = new ToolchainStateStore(paths);
    store.update((draft) => {
      draft.managed["node-lts"] = {
        activeVersion: "24.18.0",
        platformArch: `${process.platform}-${process.arch}`,
        installedVersions: ["24.18.0"],
      };
    });
    const manager = new ToolchainManager({
      userDataRoot: root,
      stateStore: store,
      isRuntimeInUse: () => true,
      fileSystem,
      registry: {
        async collect() {
          return [];
        },
      },
      probe: async () => [],
    });
    await manager.initialize();
    await assert.rejects(
      manager.performAction({ action: "remove-component", componentId: "node-lts" }),
      (error) => error?.code === "TOOLCHAIN_INSTALL_BUSY",
    );
    assert.equal(fs.existsSync(runtime), true);
    assert.equal(store.load().managed["node-lts"].activeVersion, "24.18.0");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("cooperatively cancels the active install for a fixed component ID", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-manager-install-cancel-"));
  let notifyStarted;
  const started = new Promise((resolve) => {
    notifyStarted = resolve;
  });
  try {
    const installer = {
      recoverInterruptedOperations() {},
      async install(componentId, onProgress, signal) {
        onProgress({ phase: "downloading", downloadedBytes: 0, totalBytes: 10 });
        notifyStarted();
        await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
        onProgress({ phase: "cancelled" });
        throw new ToolchainError({
          code: "TOOLCHAIN_CANCELLED",
          message: `${componentId} cancelled`,
        });
      },
    };
    const manager = new ToolchainManager({
      userDataRoot: root,
      catalog: { schemaVersion: 2, revision: 1, components: [] },
      installer,
      fileSystem,
      registry: {
        async collect() {
          return [];
        },
      },
      probe: async () => [],
    });
    await manager.initialize();
    const installing = manager.performAction({ action: "install-component", componentId: "node-lts" });
    const installationCancelled = assert.rejects(installing, (error) => error?.code === "TOOLCHAIN_CANCELLED");
    await started;
    const cancelled = await manager.performAction({ action: "cancel-component-install", componentId: "node-lts" });
    await installationCancelled;
    assert.equal(cancelled.operations.at(-1).phase, "cancelled");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
