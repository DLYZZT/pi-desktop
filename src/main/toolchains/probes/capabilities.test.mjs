import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { probeExecutableSeed } from "./capabilities.ts";
import { commandDescriptorFromCandidate, selectDefaultCandidates } from "../public-state.ts";
import { ToolchainRuntime } from "../../../agent-host/toolchain-runtime.ts";

const capabilities = [
  "shell.bash",
  "shell.powershell",
  "vcs.git",
  "js.bun",
  "python.interpreter",
  "python.uv",
  "search.rg",
  "search.fd",
  "data.jq",
  "network.curl",
];

function successfulResult(command) {
  const args = command.args.join(" ");
  let stdout = "1.2.3\n";
  if (args.includes("PI_TOOLCHAIN_BASH_OK")) stdout = "PI_TOOLCHAIN_BASH_OK\n/tmp\n";
  else if (args.includes("PI_TOOLCHAIN_POWERSHELL_OK")) stdout = "PI_TOOLCHAIN_POWERSHELL_OK\n7.5.0\n";
  else if (args.includes("rev-parse")) stdout = "true\n";
  else if (args.includes("PI_TOOLCHAIN_RG_OK")) stdout = "1:PI_TOOLCHAIN_RG_OK\n";
  else if (args.includes("pi-toolchain-fd-probe.txt")) stdout = "./pi-toolchain-fd-probe.txt\n";
  else if (args.includes(".pi")) stdout = '"PI_TOOLCHAIN_JQ_OK"\n';
  else if (args.includes("PI_TOOLCHAIN_BUN_OK")) stdout = "PI_TOOLCHAIN_BUN_OK";
  else if (args.includes("platform.python_version")) {
    stdout = JSON.stringify({
      executable: command.executable,
      version: "3.13.4",
      implementation: "cpython",
      prefix: "/opt/python",
      platform: "linux",
      machine: "x86_64",
    });
  }
  return {
    executable: command.executable,
    args: command.args,
    exitCode: 0,
    signal: null,
    stdout,
    stderr: "",
    timedOut: false,
    outputLimitExceeded: false,
    durationMs: 1,
  };
}

test("probes every reported Phase 1 capability without network or shell-profile execution", async () => {
  const commands = [];
  const executor = {
    async run(command) {
      commands.push(command);
      return successfulResult(command);
    },
  };
  const fileSystem = {
    isFile: () => true,
    isDirectory: () => true,
    readDirectoryNames: () => [],
    realpath: (filePath) => filePath,
  };

  for (const capability of capabilities) {
    const candidates = await probeExecutableSeed(
      {
        capability,
        provider: "system",
        discovery: "test",
        executable: `/tools/${capability.replaceAll(".", "-")}`,
        argvPrefix: [],
        binDir: "/tools",
        rank: 1,
      },
      { platform: "linux", arch: "x64", env: { PATH: "/usr/bin" }, fileSystem, executor },
    );
    assert.equal(candidates[0].health, "healthy", capability);
    if (capability === "python.uv") {
      assert.equal(candidates[1].capability, "python.uvx");
      assert.deepEqual(candidates[1].argvPrefix, ["tool", "run"]);
    }
  }

  assert.equal(
    commands.some((command) => command.args.some((arg) => /^https?:/i.test(arg))),
    false,
  );
  assert.equal(
    commands.some((command) => command.args.includes("-lc") || command.args.includes("-ilc")),
    false,
  );
  assert.equal(
    commands.every((command) => command.env.UV_PYTHON_DOWNLOADS === "manual"),
    true,
  );
  assert.equal(
    commands.every((command) => command.env.GIT_TERMINAL_PROMPT === "0"),
    true,
  );
});

test("marks Microsoft Store-style Python aliases broken when the isolated probe cannot run", async () => {
  const candidate = await probeExecutableSeed(
    {
      capability: "python.interpreter",
      provider: "system",
      discovery: "path",
      executable: "C:\\Users\\pi\\AppData\\Local\\Microsoft\\WindowsApps\\python.exe",
      argvPrefix: [],
      binDir: "C:\\Users\\pi\\AppData\\Local\\Microsoft\\WindowsApps",
      rank: 1,
    },
    {
      platform: "win32",
      arch: "x64",
      env: { Path: "C:\\Windows\\System32" },
      fileSystem: {
        isFile: () => true,
        isDirectory: () => true,
        readDirectoryNames: () => [],
        realpath: (filePath) => filePath,
      },
      executor: {
        async run(command) {
          return {
            executable: command.executable,
            args: command.args,
            exitCode: null,
            signal: "SIGTERM",
            stdout: "",
            stderr: "",
            timedOut: true,
            outputLimitExceeded: false,
            durationMs: 5000,
          };
        },
      },
    },
  );
  assert.equal(candidate[0].health, "broken");
  assert.equal(candidate[0].reasonCode, "TOOLCHAIN_BROKEN");
});

test("rejects wrong-platform Python and retains x64 macOS Python only as a lower-priority Rosetta candidate", async () => {
  const source = {
    capability: "python.interpreter",
    provider: "system",
    discovery: "path",
    executable: "/usr/local/bin/python3",
    argvPrefix: [],
    binDir: "/usr/local/bin",
    rank: 1,
  };
  const fileSystem = {
    isFile: () => true,
    isDirectory: () => true,
    readDirectoryNames: () => [],
    realpath: (filePath) => filePath,
  };
  const probe = (platform, machine, options) =>
    probeExecutableSeed(source, {
      ...options,
      env: {},
      fileSystem,
      executor: {
        async run(command) {
          return {
            ...successfulResult(command),
            stdout: JSON.stringify({
              executable: source.executable,
              version: "3.14.6",
              implementation: "cpython",
              prefix: "/usr/local",
              platform,
              machine,
            }),
          };
        },
      },
    });

  const wrongPlatform = await probe("win32", "AMD64", { platform: "linux", arch: "x64" });
  assert.equal(wrongPlatform[0].health, "broken");
  const rosetta = await probe("darwin", "x86_64", { platform: "darwin", arch: "arm64" });
  assert.equal(rosetta[0].health, "healthy");
  assert.equal(rosetta[0].rank, source.rank + 10_000);
});

test("classifies noexec and executable permission failures without presenting an error code as a version", async () => {
  const candidates = await probeExecutableSeed(
    {
      capability: "data.jq",
      provider: "system",
      discovery: "path",
      executable: "/mnt/noexec/jq",
      argvPrefix: [],
      binDir: "/mnt/noexec",
      rank: 1,
    },
    {
      platform: "linux",
      arch: "x64",
      env: {},
      fileSystem: {
        isFile: () => true,
        isDirectory: () => true,
        readDirectoryNames: () => [],
        realpath: (filePath) => filePath,
      },
      executor: {
        async run(command) {
          return {
            ...successfulResult(command),
            exitCode: null,
            spawnErrorCode: "EACCES",
          };
        },
      },
    },
  );
  assert.equal(candidates[0].health, "broken");
  assert.equal(candidates[0].reasonCode, "TOOLCHAIN_PERMISSION_DENIED");
  assert.equal(candidates[0].version, undefined);
});

async function probeWindowsBash(
  executable,
  { provider = "system", root, gitVersion = "2.54.0.windows.1", failBash = false } = {},
) {
  const files = new Set(
    root
      ? ["bin/bash.exe", "usr/bin/bash.exe", "usr/bin/msys-2.0.dll", "cmd/git.exe"].map((entry) =>
          path.win32.join(root, entry),
        )
      : [executable],
  );
  return probeExecutableSeed(
    {
      capability: "shell.bash",
      provider,
      discovery: "test",
      executable,
      argvPrefix: [],
      binDir: path.win32.dirname(executable),
      rank: 1,
      ...(provider === "managed" ? { componentId: "portable-git", componentRoot: root } : {}),
    },
    {
      platform: "win32",
      arch: "x64",
      env: {},
      fileSystem: {
        isFile: (file) => files.has(file),
        isDirectory: () => true,
        readDirectoryNames: () => [],
        realpath: (file) => file,
      },
      executor: {
        async run(command) {
          const result = successfulResult(command);
          if (command.args[0] === "--version") {
            result.stdout =
              command.executable === executable
                ? "GNU bash, version 5.3.9(1)-release (x86_64-pc-msys)\n"
                : `git version ${gitVersion}\n`;
          } else if (failBash) {
            result.exitCode = 1;
          }
          return result;
        },
      },
    },
  );
}

test("resolves Git Bash in versioned and custom directories through the Windows execution context", async () => {
  for (const root of [
    String.raw`D:\Soft\Tool\PortableGit-2.54.0-64-bit.7z`,
    String.raw`D:\开发工具\my shell`,
    String.raw`C:\Program Files\Git`,
    String.raw`C:\Users\pi\scoop\apps\git\current`,
    String.raw`C:\Users\pi\toolchains\staging\portable-git-random`,
  ]) {
    for (const entry of ["bin/bash.exe", "usr/bin/bash.exe"]) {
      for (const provider of ["system", "custom", "managed"]) {
        const executable = path.win32.join(root, entry);
        const candidates = await probeWindowsBash(executable, { root, provider });
        const selected = selectDefaultCandidates(candidates, { "shell.bash": provider });
        assert.equal(candidates[0].health, "healthy", executable);
        assert.equal(candidates[0].version, "5.3.9");
        assert.ok(selected["shell.bash"], executable);
        const descriptor = commandDescriptorFromCandidate(selected["shell.bash"], "win32");
        assert.equal(descriptor.cwdSemantics, "msys");
        const runtime = new ToolchainRuntime({
          platform: "win32",
          baseEnv: {},
          fetchSnapshot: async () => ({ revision: 1 }),
          resolveProject: async () => ({
            id: "git-bash-test",
            inventoryRevision: 1,
            workspaceKey: "test",
            commands: { "shell.bash": descriptor },
            summary: [],
          }),
        });
        const context = await runtime.createExecutionContext({ cwd: String.raw`D:\项目`, intent: "agent-shell" });
        assert.equal(runtime.requireFromContext("shell.bash", context).executable, executable);
        assert.equal(context.shellEnv.PI_DESKTOP_WORKSPACE_MSYS_PATH, "/d/项目");
        assert.equal(context.nativeEnv.Path, "");
        assert.equal(context.shellEnv.Path, path.win32.dirname(executable));
      }
    }
  }
});

test("does not accept a broken Git Bash or a non-Windows Git distribution", async () => {
  const root = String.raw`D:\tools\PortableGit`;
  const executable = path.win32.join(root, "bin/bash.exe");
  const broken = await probeWindowsBash(executable, { root, failBash: true });
  assert.equal(broken[0].health, "broken");
  const msys = await probeWindowsBash(executable, { root, gitVersion: "2.54.0" });
  assert.equal(msys[0].health, "unverified");
});

test("does not auto-select Cygwin, standalone MSYS2, legacy WSL, or a directory merely named Git", async () => {
  for (const executable of [
    "C:\\cygwin64\\bin\\bash.exe",
    "C:\\msys64\\usr\\bin\\bash.exe",
    "C:\\Windows\\System32\\bash.exe",
    "C:\\Git\\bin\\bash.exe",
  ]) {
    const candidates = await probeExecutableSeed(
      {
        capability: "shell.bash",
        provider: "system",
        discovery: "path",
        executable,
        argvPrefix: [],
        binDir: executable.slice(0, executable.lastIndexOf("\\")),
        rank: 1,
      },
      {
        platform: "win32",
        arch: "x64",
        env: { Path: "C:\\Windows\\System32" },
        fileSystem: {
          isFile: () => true,
          isDirectory: () => true,
          readDirectoryNames: () => [],
          realpath: (filePath) => filePath,
        },
        executor: {
          async run(command) {
            return successfulResult(command);
          },
        },
      },
    );
    assert.equal(candidates[0].health, "unverified", executable);
  }
});

test("reports an unknown future Bun major but does not mark it auto-selectable", async () => {
  const candidates = await probeExecutableSeed(
    {
      capability: "js.bun",
      provider: "system",
      discovery: "path",
      executable: "/tools/bun",
      argvPrefix: [],
      binDir: "/tools",
      rank: 1,
    },
    {
      platform: "linux",
      arch: "x64",
      env: {},
      fileSystem: {
        isFile: () => true,
        isDirectory: () => true,
        readDirectoryNames: () => [],
        realpath: (filePath) => filePath,
      },
      executor: {
        async run(command) {
          const result = successfulResult(command);
          if (command.args.includes("--version")) result.stdout = "2.0.0\n";
          return result;
        },
      },
    },
  );
  assert.equal(candidates[0].version, "2.0.0");
  assert.equal(candidates[0].health, "unverified");
  assert.equal(candidates[0].reasonCode, "TOOLCHAIN_UNVERIFIED");
});
