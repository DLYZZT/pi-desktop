import assert from "node:assert/strict";
import test from "node:test";
import { ToolchainRuntime } from "./toolchain-runtime.ts";

function descriptor(capability, executable, binDir, version = "1.0.0") {
  return {
    capability,
    provider: "system",
    executable,
    argvPrefix: [],
    binDir,
    version,
    cwdSemantics: "native",
    envPatch: {},
  };
}

function snapshot(revision, commands = {}) {
  return {
    revision,
    generatedAt: "2026-07-17T00:00:00.000Z",
    platform: "win32",
    arch: "x64",
    candidates: [],
    defaults: commands,
    publicState: {
      schemaVersion: 1,
      revision,
      platform: "win32",
      arch: "x64",
      coreReady: true,
      capabilities: {},
      components: {},
      operations: [],
    },
  };
}

function resolution(revision, commands) {
  return {
    id: `resolution-${revision}`,
    inventoryRevision: revision,
    workspaceKey: "workspace",
    requirementsHash: "requirements",
    commands,
    summary: ["JavaScript: node 22.19.0 (system)"],
  };
}

test("builds an immutable local environment with selected bins and revision", async () => {
  const original = { Path: "C:\\Windows\\System32;C:\\Tools\\Node", TOKEN: "secret" };
  const commands = {
    "js.node": descriptor("js.node", "C:\\Tools\\Node\\node.exe", "C:\\Tools\\Node", "22.19.0"),
    "vcs.git": descriptor("vcs.git", "C:\\Program Files\\Git\\cmd\\git.exe", "C:\\Program Files\\Git\\cmd", "2.50.0"),
  };
  const runtime = new ToolchainRuntime({
    platform: "win32",
    baseEnv: original,
    fetchSnapshot: async () => snapshot(3, commands),
    resolveProject: async () => resolution(3, commands),
  });

  const context = await runtime.createExecutionContext({ cwd: "C:\\项目", intent: "agent-shell" });
  assert.equal(context.inventoryRevision, 3);
  assert.equal(context.nativeEnv.PI_DESKTOP_TOOLCHAIN_REVISION, "3");
  assert.equal(context.nativeEnv.Path, "C:\\Program Files\\Git\\cmd;C:\\Tools\\Node;C:\\Windows\\System32");
  assert.equal(context.nativeEnv.TOKEN, "secret");
  assert.equal(original.Path, "C:\\Windows\\System32;C:\\Tools\\Node");
  context.commands["js.node"].argvPrefix.push("mutated");
  assert.deepEqual(runtime.getSnapshot().defaults["js.node"].argvPrefix, []);
});

test("ignores stale snapshots and refreshes mismatched resolutions", async () => {
  let fetches = 0;
  let resolves = 0;
  const commands = { "network.curl": descriptor("network.curl", "/usr/bin/curl", "/usr/bin") };
  const runtime = new ToolchainRuntime({
    platform: "linux",
    baseEnv: { PATH: "/usr/bin" },
    fetchSnapshot: async () => {
      fetches += 1;
      return snapshot(fetches === 1 ? 1 : 2, commands);
    },
    resolveProject: async () => {
      resolves += 1;
      return resolution(2, commands);
    },
  });

  const prepared = await runtime.prepare("/workspace", "project-command");
  assert.equal(prepared.inventoryRevision, 2);
  assert.equal(fetches, 2);
  assert.equal(resolves, 2);
  assert.equal(runtime.apply(snapshot(1, commands)), false);
  assert.equal(runtime.getSnapshot().revision, 2);
});

test("returns a structured capability error instead of falling back to PATH", async () => {
  const runtime = new ToolchainRuntime({
    platform: "linux",
    baseEnv: { PATH: "/usr/bin" },
    fetchSnapshot: async () => snapshot(1),
    resolveProject: async () => resolution(1, {}),
  });
  const context = await runtime.createExecutionContext({ cwd: "/workspace", intent: "skill-install" });
  assert.throws(
    () => runtime.requireFromContext("js.npx", context),
    (error) => error.code === "TOOLCHAIN_NODE_REQUIRED" && error.capability === "js.npx",
  );
});

test("executes the absolute descriptor with context-only environment", async () => {
  const commands = {
    "js.node": descriptor("js.node", process.execPath, process.execPath.slice(0, process.execPath.lastIndexOf("/"))),
  };
  const runtime = new ToolchainRuntime({
    platform: process.platform,
    baseEnv: { PATH: process.env.PATH },
    fetchSnapshot: async () => ({ ...snapshot(7, commands), platform: process.platform }),
    resolveProject: async () => resolution(7, commands),
  });
  const result = await runtime.exec(
    "js.node",
    ["-e", "process.stdout.write(process.env.PI_DESKTOP_TOOLCHAIN_REVISION || '')"],
    { cwd: process.cwd(), intent: "project-command" },
  );
  assert.equal(result.stdout, "7");
});

test("keeps trusted and untrusted project resolutions in separate caches", async () => {
  const commands = { "python.interpreter": descriptor("python.interpreter", "/python", "/") };
  const trustValues = [];
  const runtime = new ToolchainRuntime({
    platform: "linux",
    fetchSnapshot: async () => snapshot(9, commands),
    resolveProject: async (_cwd, _intent, trusted) => {
      trustValues.push(trusted);
      return { ...resolution(9, commands), id: trusted ? "trusted" : "untrusted" };
    },
  });
  const untrusted = await runtime.createExecutionContext({ cwd: "/workspace", intent: "agent-shell" });
  const trusted = await runtime.createExecutionContext({ cwd: "/workspace", intent: "agent-shell", trusted: true });
  const trustedAgain = await runtime.createExecutionContext({
    cwd: "/workspace",
    intent: "agent-shell",
    trusted: true,
  });
  assert.equal(untrusted.resolutionId, "untrusted");
  assert.equal(trusted.resolutionId, "trusted");
  assert.equal(trustedAgain.resolutionId, "trusted");
  assert.deepEqual(trustValues, [false, true]);
});

test("keeps PortableGit native Git and MSYS Bash environments isolated", async () => {
  const root = "C:\\Pi\\toolchains\\portable-git";
  const git = {
    ...descriptor("vcs.git", `${root}\\cmd\\git.exe`, `${root}\\cmd`, "2.55.0"),
    provider: "managed",
    componentId: "portable-git",
    componentRoot: root,
    pathEntries: [`${root}\\cmd`],
  };
  const bash = {
    ...descriptor("shell.bash", `${root}\\bin\\bash.exe`, `${root}\\bin`, "5.2.37"),
    provider: "managed",
    componentId: "portable-git",
    componentRoot: root,
    cwdSemantics: "msys",
    shellPathEntries: [`${root}\\cmd`, `${root}\\bin`, `${root}\\usr\\bin`, `${root}\\mingw64\\bin`],
    shellEnvPatch: { MSYSTEM: "MINGW64", CHERE_INVOKING: "1", MSYS2_PATH_TYPE: "inherit" },
  };
  const commands = { "vcs.git": git, "shell.bash": bash };
  const runtime = new ToolchainRuntime({
    platform: "win32",
    baseEnv: { Path: "C:\\Windows\\System32" },
    fetchSnapshot: async () => snapshot(12, commands),
    resolveProject: async () => resolution(12, commands),
  });
  const result = await runtime.createExecutionContext({
    cwd: "C:\\Users\\李\\project",
    intent: "agent-shell",
  });
  assert.match(result.nativeEnv.Path, /^C:\\Pi\\toolchains\\portable-git\\cmd;/);
  assert.doesNotMatch(result.nativeEnv.Path, /portable-git\\usr\\bin/i);
  assert.equal(result.nativeEnv.MSYSTEM, undefined);
  assert.match(result.shellEnv.Path, /portable-git\\usr\\bin/i);
  assert.equal(result.shellEnv.MSYSTEM, "MINGW64");
  assert.equal(result.shellEnv.PI_DESKTOP_WORKSPACE_MSYS_PATH, "/c/Users/李/project");
});
