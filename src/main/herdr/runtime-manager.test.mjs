import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { importTestBundle } from "#test-bundle";

const root = path.resolve(import.meta.dirname, "..", "..", "..");
let modulePromise;

async function loadRuntimeManager() {
  modulePromise ??= importTestBundle("src/main/herdr/runtime-manager", {
    packages: "external",
    absWorkingDir: root,
    entryPoints: ["src/main/herdr/runtime-manager.ts"],
  });
  return modulePromise;
}

function fakeHerdr(directory, { version = "0.8.2", protocol = 20, schemaVersion = 1 } = {}) {
  mkdirSync(directory, { recursive: true });
  const executable = path.join(directory, "herdr");
  writeFileSync(
    executable,
    [
      "#!/bin/sh",
      'if [ "$1" = "--version" ]; then',
      `  printf '%s\\n' 'herdr ${version}'`,
      "  exit 0",
      "fi",
      `printf '%s\\n' '${JSON.stringify({ schema_version: schemaVersion, protocol })}'`,
    ].join("\n"),
  );
  chmodSync(executable, 0o700);
  return executable;
}

function delayedPipeHerdr(directory) {
  mkdirSync(directory, { recursive: true });
  const executable = path.join(directory, "herdr-delayed-pipe");
  writeFileSync(
    executable,
    [
      "#!/bin/sh",
      'if [ "$1" = "--version" ]; then',
      "  (sleep 0.05; printf '%s\\n' 'herdr 0.8.2') &",
      "  exit 0",
      "fi",
      `  (sleep 0.05; printf '%s\\n' '${JSON.stringify({ schema_version: 1, protocol: 20 })}') &`,
      "exit 0",
    ].join("\n"),
  );
  chmodSync(executable, 0o700);
  return executable;
}

function settings(overrides = {}) {
  return {
    enabled: true,
    mode: "attach",
    sessionName: "pi-desktop-test",
    autoConnect: false,
    releaseControlOnViewClose: true,
    ...overrides,
  };
}

function emptyComponentState() {
  return {
    componentId: "herdr",
    installed: false,
    health: "missing",
    canInstall: true,
    canRepair: false,
    canRemove: false,
  };
}

function healthyComponentState() {
  return {
    componentId: "herdr",
    installed: true,
    activeVersion: "0.8.2",
    availableVersion: "0.8.2",
    health: "healthy",
    canInstall: false,
    canRepair: true,
    canRemove: true,
  };
}

function healthyInstaller() {
  return {
    inspect: healthyComponentState,
    async install() {
      return "0.8.2";
    },
    async remove() {},
  };
}

test("executable probes wait for inherited stdout pipes to close before parsing output", async (t) => {
  if (process.platform === "win32") return t.skip("POSIX pipe inheritance fixture");
  const directory = mkdtempSync(path.join(os.tmpdir(), "pi-herdr-probe-close-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const { probeHerdrExecutable } = await loadRuntimeManager();
  const result = await probeHerdrExecutable(delayedPipeHerdr(directory));
  assert.equal(result.version, "0.8.2");
  assert.equal(result.protocol, 20);
  assert.equal(result.schemaVersion, 1);
});

test("Attach mode resolves system Herdr and an isolated named-session endpoint", async (t) => {
  const { HerdrRuntimeManager } = await loadRuntimeManager();
  const directory = mkdtempSync(path.join(os.tmpdir(), "pi-herdr-runtime-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const executable = fakeHerdr(directory);
  const xdg = path.join(directory, "xdg");
  const manager = new HerdrRuntimeManager({
    userDataDir: path.join(directory, "user-data"),
    platform: "darwin",
    arch: "arm64",
    env: { PATH: directory, XDG_CONFIG_HOME: xdg },
  });

  const descriptor = await manager.initialize(settings());
  assert.equal(descriptor.version, "0.8.2");
  assert.equal(descriptor.protocol, 20);
  assert.equal(descriptor.schemaVersion, 1);
  assert.equal(descriptor.binarySource, "system");
  assert.equal(descriptor.executable, realpathSync(executable));
  assert.equal(descriptor.endpoint, path.join(xdg, "herdr", "sessions", "pi-desktop-test", "herdr.sock"));
  assert.equal(descriptor.error, undefined);
});

test("background initialization publishes immediately and skips probes when disabled", async (t) => {
  const { HerdrRuntimeManager } = await loadRuntimeManager();
  const directory = mkdtempSync(path.join(os.tmpdir(), "pi-herdr-runtime-background-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  fakeHerdr(directory);
  let releaseProbe;
  const probeBlocked = new Promise((resolve) => {
    releaseProbe = resolve;
  });
  const catalog = JSON.parse(readFileSync(path.resolve("build/herdr/runtime-catalog.json"), "utf8"));
  const manager = new HerdrRuntimeManager({
    userDataDir: path.join(directory, "user-data"),
    platform: "darwin",
    arch: "arm64",
    env: { PATH: directory, XDG_CONFIG_HOME: path.join(directory, "xdg") },
    async probe() {
      await probeBlocked;
      return {
        version: "0.8.2",
        protocol: 20,
        schemaVersion: 1,
        schemaSha256: catalog.apiSchemaSha256,
      };
    },
  });

  const startedAt = Date.now();
  const pending = manager.initializeInBackground(settings());
  assert.equal(Date.now() - startedAt < 50, true, "external probe must not block the initial descriptor");
  assert.equal(manager.getDescriptor().executable, undefined);
  assert.equal(manager.getDescriptor().probing, true);
  let settled = false;
  void pending.finally(() => {
    settled = true;
  });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(settled, false);
  releaseProbe();
  assert.equal((await pending).revision, 2);

  const marker = path.join(directory, "must-not-run");
  writeFileSync(path.join(directory, "herdr"), `#!/bin/sh\ntouch '${marker}'\n`);
  chmodSync(path.join(directory, "herdr"), 0o700);
  await manager.initializeInBackground(settings({ enabled: false }));
  assert.equal(manager.getDescriptor().enabled, false);
  assert.equal(await import("node:fs").then(({ existsSync }) => existsSync(marker)), false);
});

test("Windows remains fail-closed without probing or activating bundled Herdr", async (t) => {
  const { HerdrRuntimeManager } = await loadRuntimeManager();
  const directory = mkdtempSync(path.join(os.tmpdir(), "pi-herdr-runtime-windows-disabled-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  let installs = 0;
  const manager = new HerdrRuntimeManager({
    userDataDir: path.join(directory, "user-data"),
    platform: "win32",
    arch: "x64",
    env: { PATH: "", APPDATA: path.join(directory, "app-data") },
    installer: {
      inspect: emptyComponentState,
      async install() {
        installs += 1;
        return path.join(directory, "unused");
      },
      async remove() {},
    },
  });

  const runtime = await manager.initialize(settings({ mode: "managed" }));
  assert.equal(runtime.error?.code, "HERDR_PLATFORM_UNSUPPORTED");
  const install = await manager.installManagedRuntime();
  assert.equal(install.error?.code, "HERDR_PLATFORM_UNSUPPORTED");
  assert.equal(installs, 0);
});

test("Managed mode rejects schema hash drift while Attach uses versioned compatibility", async (t) => {
  const { HerdrRuntimeManager } = await loadRuntimeManager();
  const directory = mkdtempSync(path.join(os.tmpdir(), "pi-herdr-runtime-schema-hash-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const userDataDir = path.join(directory, "user-data");
  const managedExecutable = fakeHerdr(path.join(userDataDir, "herdr", "runtimes", "0.8.2", "darwin-arm64"));
  const manager = new HerdrRuntimeManager({
    userDataDir,
    platform: "darwin",
    arch: "arm64",
    env: { PATH: path.dirname(managedExecutable), XDG_CONFIG_HOME: path.join(directory, "xdg") },
    installer: healthyInstaller(),
  });

  const managed = await manager.initialize(settings({ mode: "managed" }));
  assert.equal(managed.error?.code, "HERDR_SCHEMA_UNSUPPORTED");
  const attached = await manager.configure(settings({ mode: "attach" }));
  assert.equal(attached.binarySource, "system");
  assert.equal(attached.error, undefined);
});

test("Managed mode verifies installer health before probing or spawning the runtime", async (t) => {
  const { HerdrRuntimeManager } = await loadRuntimeManager();
  const directory = mkdtempSync(path.join(os.tmpdir(), "pi-herdr-runtime-integrity-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const userDataDir = path.join(directory, "user-data");
  fakeHerdr(path.join(userDataDir, "herdr", "runtimes", "0.8.2", "darwin-arm64"));
  let probes = 0;
  let starts = 0;
  const manager = new HerdrRuntimeManager({
    userDataDir,
    platform: "darwin",
    arch: "arm64",
    env: { PATH: "", XDG_CONFIG_HOME: path.join(directory, "xdg") },
    installer: {
      inspect() {
        return { ...healthyComponentState(), health: "modified" };
      },
      async install() {},
      async remove() {},
    },
    serverSupervisor: {
      setListener() {},
      async ensureRunning() {
        starts += 1;
      },
      async stop() {},
    },
    async probe() {
      probes += 1;
      throw new Error("must not probe a modified runtime");
    },
  });

  const descriptor = await manager.initialize(settings({ mode: "managed" }));
  assert.equal(descriptor.error?.code, "HERDR_BINARY_INTEGRITY_FAILED");
  assert.equal(probes, 0);
  assert.equal(starts, 0);
});

test("probe failures expose a short stable error without stderr or executable paths", async (t) => {
  const { HerdrRuntimeManager } = await loadRuntimeManager();
  const directory = mkdtempSync(path.join(os.tmpdir(), "pi-herdr-runtime-redaction-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const executable = path.join(directory, "herdr");
  writeFileSync(executable, "#!/bin/sh\nprintf '%s\\n' 'secret-prompt /Users/private/token' >&2\nexit 2\n");
  chmodSync(executable, 0o700);
  const manager = new HerdrRuntimeManager({
    userDataDir: path.join(directory, "user-data"),
    platform: "darwin",
    arch: "arm64",
    env: { PATH: directory, XDG_CONFIG_HOME: path.join(directory, "xdg") },
  });

  const descriptor = await manager.initialize(settings());
  assert.equal(descriptor.error?.message, "Herdr executable probe failed.");
  assert.equal(JSON.stringify(descriptor.error).includes("secret-prompt"), false);
  assert.equal(JSON.stringify(descriptor.error).includes(directory), false);
});

test("concurrent managed lifecycle requests share one activation", async (t) => {
  const { HerdrRuntimeManager } = await loadRuntimeManager();
  const directory = mkdtempSync(path.join(os.tmpdir(), "pi-herdr-runtime-install-single-flight-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  let installs = 0;
  const manager = new HerdrRuntimeManager({
    userDataDir: path.join(directory, "user-data"),
    platform: "darwin",
    arch: "arm64",
    env: { PATH: "", XDG_CONFIG_HOME: path.join(directory, "xdg") },
    installer: {
      inspect: emptyComponentState,
      async install() {
        installs += 1;
        await new Promise((resolve) => setTimeout(resolve, 25));
        return path.join(directory, "unused");
      },
      async remove() {},
    },
  });
  await manager.initialize(settings({ enabled: false, mode: "managed" }));

  const [first, second] = await Promise.all([manager.installManagedRuntime(), manager.installManagedRuntime()]);
  assert.equal(installs, 1);
  assert.deepEqual(first, second);
});

test("Attach compatibility is fail-closed for old and unknown Herdr protocols", async (t) => {
  const { HerdrRuntimeManager } = await loadRuntimeManager();
  const directory = mkdtempSync(path.join(os.tmpdir(), "pi-herdr-compat-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const cases = [
    { version: "0.7.1", protocol: 14, code: "HERDR_PROTOCOL_UNSUPPORTED" },
    { version: "0.8.0", protocol: 19, code: "HERDR_PROTOCOL_UNSUPPORTED" },
    { version: "0.8.3", protocol: 21, code: "HERDR_PROTOCOL_UNSUPPORTED" },
    { version: "0.9.0", protocol: 20, code: "HERDR_VERSION_UNSUPPORTED" },
  ];
  for (const [index, fixture] of cases.entries()) {
    const caseRoot = path.join(directory, String(index));
    fakeHerdr(caseRoot, fixture);
    const manager = new HerdrRuntimeManager({
      userDataDir: path.join(caseRoot, "user-data"),
      platform: "darwin",
      arch: "arm64",
      env: { PATH: caseRoot, XDG_CONFIG_HOME: path.join(caseRoot, "xdg") },
    });
    const descriptor = await manager.initialize(settings());
    assert.equal(descriptor.error?.code, fixture.code, `${fixture.version}/protocol ${fixture.protocol}`);
  }
});

test("HERDR_CONFIG_PATH alone never changes the Session data endpoint", async (t) => {
  const { HerdrRuntimeManager } = await loadRuntimeManager();
  const directory = mkdtempSync(path.join(os.tmpdir(), "pi-herdr-config-path-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  fakeHerdr(directory);
  const manager = new HerdrRuntimeManager({
    userDataDir: path.join(directory, "user-data"),
    platform: "darwin",
    arch: "arm64",
    env: { PATH: directory, HERDR_CONFIG_PATH: path.join(directory, "config.toml") },
  });
  const descriptor = await manager.initialize(settings());
  assert.equal(descriptor.endpoint?.startsWith(directory), false);
  assert.equal(descriptor.endpoint?.includes(".config/herdr/sessions/pi-desktop-test/herdr.sock"), true);
});

test("configuration publishes immutable settings with strictly increasing revisions", async (t) => {
  const { HerdrRuntimeManager } = await loadRuntimeManager();
  const directory = mkdtempSync(path.join(os.tmpdir(), "pi-herdr-runtime-order-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  fakeHerdr(directory);
  const xdg = path.join(directory, "xdg");
  const manager = new HerdrRuntimeManager({
    userDataDir: path.join(directory, "user-data"),
    platform: "darwin",
    arch: "arm64",
    env: { PATH: directory, XDG_CONFIG_HOME: xdg },
  });
  const published = [];
  manager.setListener((descriptor) => published.push(descriptor));

  const [first, second] = await Promise.all([
    manager.configure(settings({ sessionName: "session-a" })),
    manager.configure(settings({ sessionName: "session-b" })),
  ]);
  assert.equal(first.sessionName, "session-a");
  assert.equal(second.sessionName, "session-b");
  assert.deepEqual(
    published.map((descriptor) => descriptor.revision),
    [1, 2],
  );
  assert.deepEqual(manager.getSettings(), settings({ sessionName: "session-b" }));
});

test("Managed owns the Session server while Attach and disabled settings only stop owned children", async (t) => {
  const { HerdrRuntimeManager } = await loadRuntimeManager();
  const directory = mkdtempSync(path.join(os.tmpdir(), "pi-herdr-managed-server-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const userDataDir = path.join(directory, "user-data");
  const managedDirectory = path.join(userDataDir, "herdr", "runtimes", "0.8.2", "darwin-arm64");
  const executable = fakeHerdr(managedDirectory);
  const catalog = JSON.parse(readFileSync(path.resolve("build/herdr/runtime-catalog.json"), "utf8"));
  const starts = [];
  let stops = 0;
  let serverListener = () => {};
  const serverSupervisor = {
    setListener(listener) {
      serverListener = listener;
    },
    async ensureRunning(target) {
      starts.push(target);
    },
    async stop() {
      stops += 1;
    },
  };
  const manager = new HerdrRuntimeManager({
    userDataDir,
    platform: "darwin",
    arch: "arm64",
    env: { PATH: managedDirectory, XDG_CONFIG_HOME: path.join(directory, "xdg") },
    installer: healthyInstaller(),
    serverSupervisor,
    async probe() {
      return {
        version: "0.8.2",
        protocol: 20,
        schemaVersion: 1,
        schemaSha256: catalog.apiSchemaSha256,
      };
    },
  });

  const managed = await manager.initialize(settings({ mode: "managed", sessionName: "managed-a" }));
  assert.equal(managed.error, undefined);
  assert.deepEqual(starts, [
    {
      executable: realpathSync(executable),
      sessionName: "managed-a",
      endpoint: path.join(directory, "xdg", "herdr", "sessions", "managed-a", "herdr.sock"),
    },
  ]);

  await manager.configure(settings({ mode: "managed", sessionName: "managed-b" }));
  assert.equal(starts.at(-1).sessionName, "managed-b");
  const beforeAttachStops = stops;
  const attached = await manager.configure(settings({ mode: "attach", sessionName: "managed-b" }));
  assert.equal(attached.binarySource, "system");
  assert.equal(stops, beforeAttachStops + 1);

  await manager.configure(settings({ enabled: false, mode: "managed" }));
  assert.equal(stops, beforeAttachStops + 2);
  assert.equal(typeof serverListener, "function");
});

test("Managed repair stops the owned server before activation and restarts it from the verified runtime", async (t) => {
  const { HerdrRuntimeManager } = await loadRuntimeManager();
  const directory = mkdtempSync(path.join(os.tmpdir(), "pi-herdr-managed-repair-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const userDataDir = path.join(directory, "user-data");
  fakeHerdr(path.join(userDataDir, "herdr", "runtimes", "0.8.2", "darwin-arm64"));
  const catalog = JSON.parse(readFileSync(path.resolve("build/herdr/runtime-catalog.json"), "utf8"));
  const actions = [];
  const manager = new HerdrRuntimeManager({
    userDataDir,
    platform: "darwin",
    arch: "arm64",
    env: { PATH: "", XDG_CONFIG_HOME: path.join(directory, "xdg") },
    installer: {
      inspect: healthyComponentState,
      async install() {
        actions.push("install");
        return "0.8.2";
      },
      async remove() {},
    },
    serverSupervisor: {
      setListener() {},
      async ensureRunning() {
        actions.push("start");
      },
      async stop() {
        actions.push("stop");
      },
    },
    async probe() {
      return {
        version: "0.8.2",
        protocol: 20,
        schemaVersion: 1,
        schemaSha256: catalog.apiSchemaSha256,
      };
    },
  });
  await manager.initialize(settings({ mode: "managed" }));
  actions.length = 0;

  await manager.installManagedRuntime();
  assert.deepEqual(actions, ["stop", "install", "start"]);
});

test("shutdown stops Managed immediately and prevents an in-flight probe from starting a late server", async (t) => {
  const { HerdrRuntimeManager } = await loadRuntimeManager();
  const directory = mkdtempSync(path.join(os.tmpdir(), "pi-herdr-managed-shutdown-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const userDataDir = path.join(directory, "user-data");
  fakeHerdr(path.join(userDataDir, "herdr", "runtimes", "0.8.2", "darwin-arm64"));
  const catalog = JSON.parse(readFileSync(path.resolve("build/herdr/runtime-catalog.json"), "utf8"));
  let releaseProbe;
  const probeBlocked = new Promise((resolve) => {
    releaseProbe = resolve;
  });
  let starts = 0;
  let stops = 0;
  const manager = new HerdrRuntimeManager({
    userDataDir,
    platform: "darwin",
    arch: "arm64",
    env: { PATH: "", XDG_CONFIG_HOME: path.join(directory, "xdg") },
    installer: healthyInstaller(),
    serverSupervisor: {
      setListener() {},
      async ensureRunning() {
        starts += 1;
      },
      async stop() {
        stops += 1;
      },
    },
    async probe() {
      await probeBlocked;
      return {
        version: "0.8.2",
        protocol: 20,
        schemaVersion: 1,
        schemaSha256: catalog.apiSchemaSha256,
      };
    },
  });

  const configuring = manager.initialize(settings({ mode: "managed" }));
  await new Promise((resolve) => setTimeout(resolve, 5));
  await manager.stopManagedServer();
  assert.equal(stops, 1);
  releaseProbe();
  await configuring;
  assert.equal(starts, 0);
  assert.equal(stops, 2);
  await manager.configure(settings({ mode: "managed", autoConnect: true }));
  assert.equal(starts, 0, "late configure must not unsuspend a shutting-down Managed server");
});

test("an invalid runtime catalog degrades only Herdr instead of bricking application startup", async (t) => {
  const { HerdrRuntimeManager } = await loadRuntimeManager();
  const directory = mkdtempSync(path.join(os.tmpdir(), "pi-herdr-bad-catalog-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const catalogPath = path.join(directory, "runtime-catalog.json");
  writeFileSync(catalogPath, "{broken");
  const manager = new HerdrRuntimeManager({
    userDataDir: path.join(directory, "user-data"),
    platform: "darwin",
    arch: "arm64",
    catalogPath,
    installer: {
      inspect: emptyComponentState,
      async install() {
        throw new Error("unavailable");
      },
      async remove() {},
    },
    serverSupervisor: {
      setListener() {},
      async ensureRunning() {
        assert.fail("invalid catalog must never start Managed Herdr");
      },
      async stop() {},
    },
  });
  const descriptor = await manager.initialize(settings({ mode: "managed" }));
  assert.equal(descriptor.error?.code, "HERDR_BINARY_INTEGRITY_FAILED");
  assert.equal(manager.getManagedComponentState().health, "broken");
});

test("shipped catalog pins official v0.8.2 release assets and digests", () => {
  const catalog = JSON.parse(readFileSync(path.resolve("build/herdr/runtime-catalog.json"), "utf8"));
  assert.equal(catalog.version, "0.8.2");
  assert.equal(catalog.protocol, 20);
  assert.equal(catalog.apiSchemaVersion, 1);
  for (const key of ["darwin-arm64", "darwin-x64", "linux-x64", "win32-x64"]) {
    const artifact = catalog.artifacts[key];
    assert.match(artifact.url, /^https:\/\/github\.com\/herdrdev\/herdr\/releases\/download\/v0\.8\.2\//);
    assert.match(artifact.sha256, /^[a-f0-9]{64}$/);
  }
});
