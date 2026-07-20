import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ManagedComponentInstaller } from "./installer.ts";
import { createToolchainPaths, runtimeDirectory } from "./paths.ts";
import { ToolchainStateStore } from "./state-store.ts";

const artifact = Buffer.from("fake archive bytes");
const sha256 = createHash("sha256").update(artifact).digest("hex");

function catalog() {
  return {
    schemaVersion: 2,
    revision: 7,
    components: [
      {
        id: "node-lts",
        version: "24.18.0",
        provides: ["js.node", "js.npm", "js.npx"],
        license: { name: "Node", url: "https://example.invalid/license" },
        variants: [
          {
            platform: process.platform,
            arch: process.arch,
            url: "https://nodejs.org/dist/v24.18.0/fake.tar.gz",
            sha256,
            downloadBytes: artifact.length,
            archive: "tar.gz",
            installer: "safe-archive",
          },
        ],
      },
    ],
  };
}

function candidate(seed, capability) {
  return {
    id: capability,
    capability,
    provider: "managed",
    discovery: seed.discovery,
    executable: seed.executable,
    argvPrefix: [],
    binDir: seed.binDir,
    componentId: seed.componentId,
    componentRoot: seed.componentRoot,
    version: "24.18.0",
    health: "healthy",
    rank: 5_000,
  };
}

test("installs a fixed single-binary jq artifact without an external extractor", async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "pi-managed-jq-install-"));
  try {
    const paths = createToolchainPaths(directory);
    const store = new ToolchainStateStore(paths);
    let extracted = false;
    const jqCatalog = {
      schemaVersion: 2,
      revision: 8,
      components: [
        {
          id: "jq",
          version: "1.8.2",
          provides: ["data.jq"],
          license: { name: "MIT", url: "https://example.invalid/license" },
          variants: [
            {
              platform: process.platform,
              arch: process.arch,
              url: "https://github.com/jqlang/jq/releases/download/jq-1.8.2/jq-test",
              sha256,
              downloadBytes: artifact.length,
              archive: "binary",
              installer: "single-binary",
            },
          ],
        },
      ],
    };
    const installer = new ManagedComponentInstaller({
      paths,
      stateStore: store,
      catalog: jqCatalog,
      download: async (_componentId, _variant, destination) => {
        mkdirSync(path.dirname(destination), { recursive: true });
        writeFileSync(destination, artifact);
      },
      extract: async () => {
        extracted = true;
      },
      probe: async (seed) => [candidate(seed, "data.jq")],
    });
    const state = await installer.install("jq");
    const root = runtimeDirectory(paths, "jq", "1.8.2", process.platform, process.arch);
    assert.equal(state.managed.jq.activeVersion, "1.8.2");
    assert.equal(extracted, false);
    assert.equal(existsSync(path.join(root, process.platform === "win32" ? "jq.exe" : "jq")), true);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("PortableGit special installer probes and activates coupled native Git and MSYS Bash", async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "pi-managed-portable-git-"));
  try {
    const paths = createToolchainPaths(directory);
    const store = new ToolchainStateStore(paths);
    const portableCatalog = {
      schemaVersion: 2,
      revision: 9,
      components: [
        {
          id: "portable-git",
          version: "2.55.0.3",
          provides: ["vcs.git", "shell.bash"],
          license: { name: "GPL", url: "https://example.invalid/license" },
          variants: [
            {
              platform: "win32",
              arch: "x64",
              url: "https://github.com/git-for-windows/git/releases/download/v2.55.0.windows.3/test.exe",
              sha256,
              downloadBytes: artifact.length,
              archive: "7z-sfx",
              installer: "portable-git-sfx",
            },
          ],
        },
      ],
    };
    let extractionOptions;
    let extractedArtifact;
    const installer = new ManagedComponentInstaller({
      paths,
      stateStore: store,
      catalog: portableCatalog,
      platform: "win32",
      arch: "x64",
      download: async (_componentId, _variant, destination) => {
        mkdirSync(path.dirname(destination), { recursive: true });
        writeFileSync(destination, artifact);
      },
      extractPortableGit: async (archivePath, destination, options) => {
        extractedArtifact = archivePath;
        extractionOptions = options;
        mkdirSync(path.join(destination, "cmd"), { recursive: true });
        mkdirSync(path.join(destination, "bin"), { recursive: true });
        writeFileSync(path.join(destination, "cmd", "git.exe"), "git");
        writeFileSync(path.join(destination, "bin", "bash.exe"), "bash");
      },
      probe: async (seed) => [candidate(seed, seed.capability)],
    });
    const state = await installer.install("portable-git");
    const root = runtimeDirectory(paths, "portable-git", "2.55.0.3", "win32", "x64");
    assert.equal(extractionOptions.platform, "win32");
    assert.match(path.basename(extractedArtifact), /\.7z\.exe$/);
    assert.equal(state.managed["portable-git"].activeVersion, "2.55.0.3");
    assert.equal(existsSync(path.join(root, "cmd", "git.exe")), true);
    assert.equal(existsSync(path.join(root, "bin", "bash.exe")), true);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

function createInstaller(directory, probe, stateStore) {
  const paths = createToolchainPaths(directory);
  const store = stateStore ?? new ToolchainStateStore(paths);
  return {
    paths,
    store,
    installer: new ManagedComponentInstaller({
      paths,
      stateStore: store,
      catalog: catalog(),
      download: async (_componentId, _variant, destination, options) => {
        mkdirSync(path.dirname(destination), { recursive: true });
        writeFileSync(destination, artifact);
        options.onProgress?.({ downloadedBytes: artifact.length, totalBytes: artifact.length });
      },
      extract: async (_archivePath, destination) => {
        const executable = path.join(destination, "node", "bin", process.platform === "win32" ? "node.exe" : "node");
        mkdirSync(path.dirname(executable), { recursive: true });
        writeFileSync(executable, "fake node", { mode: 0o755 });
      },
      probe,
      now: () => new Date("2026-07-17T00:00:00.000Z"),
    }),
  };
}

test("probes before atomically activating a managed runtime", async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "pi-managed-install-"));
  try {
    const phases = [];
    const { paths, store, installer } = createInstaller(directory, async (seed) => [
      candidate(seed, "js.node"),
      candidate(seed, "js.npm"),
      candidate(seed, "js.npx"),
    ]);
    const state = await installer.install("node-lts", (progress) => phases.push(progress.phase));
    assert.equal(state.managed["node-lts"].activeVersion, "24.18.0");
    assert.equal(store.load().revision, 1);
    assert.equal(existsSync(runtimeDirectory(paths, "node-lts", "24.18.0", process.platform, process.arch)), true);
    assert.deepEqual(phases, [
      "downloading",
      "downloading",
      "verifying",
      "extracting",
      "probing",
      "activating",
      "ready",
    ]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a failed staging probe leaves the previous active runtime untouched", async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "pi-managed-install-rollback-"));
  try {
    const { paths, store, installer } = createInstaller(directory, async (seed) => [
      { ...candidate(seed, "js.node"), health: "broken" },
    ]);
    const oldRoot = runtimeDirectory(paths, "node-lts", "23.0.0", process.platform, process.arch);
    mkdirSync(oldRoot, { recursive: true });
    writeFileSync(path.join(oldRoot, "sentinel"), "old");
    store.update((draft) => {
      draft.managed["node-lts"] = {
        activeVersion: "23.0.0",
        platformArch: `${process.platform}-${process.arch}`,
        installedVersions: ["23.0.0"],
      };
    });
    await assert.rejects(installer.install("node-lts"), (error) => error.code === "TOOLCHAIN_BROKEN");
    assert.equal(store.load().managed["node-lts"].activeVersion, "23.0.0");
    assert.equal(existsSync(path.join(oldRoot, "sentinel")), true);
    assert.equal(existsSync(runtimeDirectory(paths, "node-lts", "24.18.0", process.platform, process.arch)), false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a state write failure restores the previous same-version runtime", async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "pi-managed-install-state-rollback-"));
  try {
    const paths = createToolchainPaths(directory);
    const durableStore = new ToolchainStateStore(paths);
    const finalRoot = runtimeDirectory(paths, "node-lts", "24.18.0", process.platform, process.arch);
    mkdirSync(finalRoot, { recursive: true });
    writeFileSync(path.join(finalRoot, "sentinel"), "previous-runtime");
    durableStore.update((draft) => {
      draft.managed["node-lts"] = {
        activeVersion: "24.18.0",
        platformArch: `${process.platform}-${process.arch}`,
        installedVersions: ["24.18.0"],
      };
    });

    class FailingStateStore extends ToolchainStateStore {
      update() {
        throw new Error("simulated state write failure");
      }
    }

    const { installer } = createInstaller(
      directory,
      async (seed) => [candidate(seed, "js.node"), candidate(seed, "js.npm"), candidate(seed, "js.npx")],
      new FailingStateStore(paths),
    );
    await assert.rejects(installer.install("node-lts"), (error) => error.code === "TOOLCHAIN_INTERNAL");
    assert.equal(durableStore.load().managed["node-lts"].activeVersion, "24.18.0");
    assert.equal(existsSync(path.join(finalRoot, "sentinel")), true);
    assert.deepEqual(
      readdirSync(path.dirname(finalRoot)).filter((name) => name.includes(".previous-")),
      [],
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a live component lock rejects a concurrent installer without disturbing the active install", async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "pi-managed-install-lock-"));
  let releaseProbe;
  const probeGate = new Promise((resolve) => {
    releaseProbe = resolve;
  });
  try {
    const paths = createToolchainPaths(directory);
    const store = new ToolchainStateStore(paths);
    const { installer } = createInstaller(
      directory,
      async (seed) => {
        await probeGate;
        return [candidate(seed, "js.node"), candidate(seed, "js.npm"), candidate(seed, "js.npx")];
      },
      store,
    );
    const first = installer.install("node-lts");
    await assert.rejects(installer.install("node-lts"), (error) => error.code === "TOOLCHAIN_INSTALL_BUSY");
    releaseProbe();
    const state = await first;
    assert.equal(state.managed["node-lts"].activeVersion, "24.18.0");
    assert.equal(existsSync(path.join(paths.locks, "node-lts.lock")), false);
  } finally {
    releaseProbe?.();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("startup recovery removes partial/install residue and restores interrupted runtime renames", () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "pi-managed-install-recovery-"));
  try {
    const { paths, store, installer } = createInstaller(directory, async () => []);
    mkdirSync(paths.downloads, { recursive: true });
    writeFileSync(path.join(paths.downloads, "node-lts.artifact.partial"), "partial");
    mkdirSync(path.join(paths.staging, "node-lts-abandoned"), { recursive: true });

    const active = runtimeDirectory(paths, "node-lts", "24.18.0", process.platform, process.arch);
    const previous = `${active}.previous-12345678-1234-1234-1234-123456789abc`;
    mkdirSync(previous, { recursive: true });
    writeFileSync(path.join(previous, "sentinel"), "previous");
    store.update((draft) => {
      draft.managed["node-lts"] = {
        activeVersion: "24.18.0",
        platformArch: `${process.platform}-${process.arch}`,
        installedVersions: ["24.18.0"],
      };
    });

    installer.recoverInterruptedOperations();
    assert.equal(existsSync(path.join(paths.downloads, "node-lts.artifact.partial")), false);
    assert.equal(existsSync(path.join(paths.staging, "node-lts-abandoned")), false);
    assert.equal(existsSync(path.join(active, "sentinel")), true);
    assert.equal(existsSync(previous), false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("startup recovery restores a component staged by an interrupted removal", () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "pi-managed-remove-recovery-"));
  try {
    const { paths, store, installer } = createInstaller(directory, async () => []);
    const componentRoot = path.join(paths.runtimes, "node-lts");
    const active = runtimeDirectory(paths, "node-lts", "24.18.0", process.platform, process.arch);
    mkdirSync(active, { recursive: true });
    writeFileSync(path.join(active, "sentinel"), "active");
    store.update((draft) => {
      draft.managed["node-lts"] = {
        activeVersion: "24.18.0",
        platformArch: `${process.platform}-${process.arch}`,
        installedVersions: ["24.18.0"],
      };
    });
    mkdirSync(paths.staging, { recursive: true });
    const staged = path.join(paths.staging, "remove-node-lts-12345678-1234-1234-1234-123456789abc");
    renameSync(componentRoot, staged);

    installer.recoverInterruptedOperations();
    assert.equal(existsSync(path.join(active, "sentinel")), true);
    assert.equal(existsSync(staged), false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("cancelling an install cleans partial data and never activates the component", async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "pi-managed-install-cancel-"));
  let releaseDownload;
  let downloadStarted;
  const started = new Promise((resolve) => {
    downloadStarted = resolve;
  });
  const gate = new Promise((resolve) => {
    releaseDownload = resolve;
  });
  try {
    const paths = createToolchainPaths(directory);
    const store = new ToolchainStateStore(paths);
    const phases = [];
    const installer = new ManagedComponentInstaller({
      paths,
      stateStore: store,
      catalog: catalog(),
      download: async (_componentId, _variant, destination) => {
        mkdirSync(path.dirname(destination), { recursive: true });
        writeFileSync(destination, artifact);
        downloadStarted();
        await gate;
      },
      probe: async () => assert.fail("cancelled install must not probe"),
    });
    const controller = new globalThis.AbortController();
    const pending = installer.install("node-lts", (progress) => phases.push(progress.phase), controller.signal);
    await started;
    controller.abort();
    releaseDownload();
    await assert.rejects(pending, (error) => error.code === "TOOLCHAIN_CANCELLED");
    assert.equal(phases.at(-1), "cancelled");
    assert.equal(
      readdirSync(paths.downloads).some((name) => name.endsWith(".partial")),
      false,
    );
    assert.equal(store.load().managed["node-lts"], undefined);
  } finally {
    releaseDownload?.();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("startup recovery leaves runtime and staging ownership untouched for a future state schema", () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "pi-managed-future-recovery-"));
  try {
    const paths = createToolchainPaths(directory);
    mkdirSync(paths.root, { recursive: true });
    writeFileSync(
      paths.stateFile,
      `${JSON.stringify({ schemaVersion: 99, revision: 1, preferences: {}, managed: {} })}\n`,
      "utf8",
    );
    const active = runtimeDirectory(paths, "node-lts", "24.18.0", process.platform, process.arch);
    const previous = `${active}.previous-12345678-1234-1234-1234-123456789abc`;
    mkdirSync(previous, { recursive: true });
    const staged = path.join(paths.staging, "node-lts-owned-by-newer-version");
    mkdirSync(staged, { recursive: true });
    const installer = new ManagedComponentInstaller({
      paths,
      stateStore: new ToolchainStateStore(paths),
      catalog: catalog(),
    });

    installer.recoverInterruptedOperations();
    assert.equal(existsSync(previous), true);
    assert.equal(existsSync(active), false);
    assert.equal(existsSync(staged), true);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
