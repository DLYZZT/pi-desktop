import assert from "node:assert/strict";
import test from "node:test";
import { probeExecutableSeed } from "./capabilities.ts";

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

test("does not auto-select Cygwin, standalone MSYS2, or legacy WSL bash", async () => {
  for (const executable of [
    "C:\\cygwin64\\bin\\bash.exe",
    "C:\\msys64\\usr\\bin\\bash.exe",
    "C:\\Windows\\System32\\bash.exe",
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
