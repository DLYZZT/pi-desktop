import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { DiscoveryRegistry, parsePep514ExecutablePaths, parsePythonLauncherPaths } from "./discovery-registry.ts";

function memoryFileSystem({ files = [], directories = {} } = {}) {
  const fileSet = new Set(files);
  const directoryMap = new Map(Object.entries(directories));
  const reads = [];
  return {
    reads,
    isFile(filePath) {
      return fileSet.has(filePath);
    },
    isDirectory(directoryPath) {
      return directoryMap.has(directoryPath);
    },
    readDirectoryNames(directoryPath) {
      reads.push(directoryPath);
      return [...(directoryMap.get(directoryPath) ?? [])];
    },
    realpath(filePath) {
      return filePath;
    },
  };
}

test("finds Homebrew versioned Node when Finder PATH omits its bin directory", async () => {
  const fileSystem = memoryFileSystem({
    files: ["/usr/bin/git", "/opt/homebrew/opt/node@22/bin/node"],
    directories: {
      "/opt/homebrew/opt": ["node@22", "unrelated", "python@3.13"],
      "/usr/local/opt": [],
      "/Users/测试/.nvm/versions/node": [],
      "/Users/测试/.local/share/fnm/node-versions": [],
      "/Users/测试/.pyenv/versions": [],
    },
  });
  const registry = new DiscoveryRegistry({
    platform: "darwin",
    arch: "arm64",
    env: { PATH: "/usr/bin" },
    homeDir: "/Users/测试",
    fileSystem,
  });

  const seeds = await registry.collect();
  const node = seeds.find((seed) => seed.capability === "js.node");
  assert.equal(node?.executable, "/opt/homebrew/opt/node@22/bin/node");
  assert.equal(node?.discovery, "homebrew-formula:node@22");
  assert.equal(seeds.find((seed) => seed.capability === "vcs.git")?.pathOrder, 0);
  assert.equal(
    fileSystem.reads.some((directory) => directory.includes("Cellar")),
    false,
  );
});

test("finds macOS user installs for Bun, fnm, Conda, and python.org outside Finder PATH", async () => {
  const home = "/Users/测试 User";
  const fnmRoot = `${home}/Library/Application Support/fnm/node-versions`;
  const files = [
    `${home}/.bun/bin/bun`,
    `${fnmRoot}/v24.18.0/installation/bin/node`,
    `${home}/miniforge3/bin/python3`,
    "/Library/Frameworks/Python.framework/Versions/3.14/bin/python3",
  ];
  const fileSystem = memoryFileSystem({
    files,
    directories: {
      "/opt/homebrew/opt": [],
      "/usr/local/opt": [],
      "/Library/Frameworks/Python.framework/Versions": ["3.14"],
      [`${home}/.nvm/versions/node`]: [],
      [fnmRoot]: ["v24.18.0"],
      [`${home}/.pyenv/versions`]: [],
    },
  });
  const registry = new DiscoveryRegistry({
    platform: "darwin",
    arch: "arm64",
    env: { PATH: "/usr/bin" },
    homeDir: home,
    fileSystem,
  });

  const seeds = await registry.collect();
  for (const executable of files)
    assert.ok(
      seeds.some((seed) => seed.executable === executable),
      executable,
    );
  assert.equal(seeds.find((seed) => seed.executable === `${home}/.bun/bin/bun`)?.discovery, "bun-home");
  assert.equal(
    seeds.find((seed) => seed.executable === `${fnmRoot}/v24.18.0/installation/bin/node`)?.discovery,
    "fnm:v24.18.0",
  );
});

test("uses bounded version-manager roots without executing shell profiles", async () => {
  const versions = Array.from({ length: 100 }, (_, index) => `v22.${index}`);
  const files = versions.slice(0, 64).map((version) => `/home/pi/.nvm/versions/node/${version}/bin/node`);
  const fileSystem = memoryFileSystem({
    files,
    directories: {
      "/home/pi/.nvm/versions/node": versions,
      "/home/pi/.local/share/fnm/node-versions": [],
      "/home/pi/.pyenv/versions": [],
    },
  });
  const executor = {
    async run() {
      assert.fail("POSIX discovery must not execute a shell or version-manager command");
    },
  };
  const registry = new DiscoveryRegistry({
    platform: "linux",
    env: { PATH: "" },
    homeDir: "/home/pi",
    fileSystem,
    executor,
  });

  const seeds = await registry.collect();
  assert.equal(seeds.filter((seed) => seed.capability === "js.node").length, 64);
});

test("resolves an existing npmCommand wrapper from bounded known locations as a probed custom seed", async () => {
  const fileSystem = memoryFileSystem({
    files: ["/Users/测试 User/.local/bin/mise"],
    directories: {
      "/opt/homebrew/opt": [],
      "/usr/local/opt": [],
      "/Library/Frameworks/Python.framework/Versions": [],
      "/Users/测试 User/.nvm/versions/node": [],
      "/Users/测试 User/Library/Application Support/fnm/node-versions": [],
      "/Users/测试 User/.pyenv/versions": [],
    },
  });
  const registry = new DiscoveryRegistry({
    platform: "darwin",
    arch: "arm64",
    env: { PATH: "/usr/bin" },
    homeDir: "/Users/测试 User",
    fileSystem,
    legacyNpmCommand: ["mise", "exec", "node@22", "--", "npm"],
  });

  const npm = (await registry.collect()).find((entry) => entry.discovery === "legacy-npm-command");
  assert.equal(npm?.provider, "custom");
  assert.equal(npm?.capability, "js.npm");
  assert.equal(npm?.executable, "/Users/测试 User/.local/bin/mise");
  assert.deepEqual(npm?.argvPrefix, ["exec", "node@22", "--", "npm"]);
});

test("collects Windows official, Git, Scoop, launcher, where, and PEP 514 candidates", async () => {
  const files = [
    "C:\\Program Files\\nodejs\\node.exe",
    "C:\\Program Files\\Git\\cmd\\git.exe",
    "C:\\Program Files\\Git\\bin\\bash.exe",
    "C:\\Users\\李\\scoop\\apps\\ripgrep\\current\\rg.exe",
    "C:\\Users\\李\\AppData\\Local\\Programs\\Python\\Python313\\python.exe",
    "C:\\Users\\李\\AppData\\Local\\Programs\\Python\\Launcher\\py.exe",
    "C:\\Users\\李\\AppData\\Local\\mise\\shims\\node.exe",
    "C:\\Users\\李\\.bun\\bin\\bun.exe",
    "C:\\Users\\李\\AppData\\Roaming\\fnm\\node-versions\\v24.18.0\\installation\\node.exe",
    "C:\\Users\\李\\miniforge3\\python.exe",
    "C:\\Windows\\System32\\where.exe",
    "C:\\Windows\\System32\\reg.exe",
    "C:\\Tools\\uv.exe",
    "C:\\Python312\\python.exe",
    "C:\\Registry Python\\python.exe",
  ];
  const fileSystem = memoryFileSystem({
    files,
    directories: {
      "C:\\Users\\李\\AppData\\Local\\Programs\\Python": ["Python313"],
      "C:\\Users\\李\\AppData\\Roaming\\fnm\\node-versions": ["v24.18.0"],
      "C:\\Users\\李\\.pyenv\\pyenv-win\\versions": [],
    },
  });
  const commands = [];
  const executor = {
    async run(command) {
      commands.push(command);
      if (path.win32.basename(command.executable).toLowerCase() === "where.exe") {
        return result(command, "C:\\Windows\\py.exe\r\nC:\\Tools\\uv.exe\r\n");
      }
      if (path.win32.basename(command.executable).toLowerCase() === "py.exe") {
        return result(command, " -V:3.12 *        C:\\Python312\\python.exe\r\n");
      }
      return result(command, "    ExecutablePath    REG_SZ    C:\\Registry Python\\python.exe\r\n");
    },
  };
  const registry = new DiscoveryRegistry({
    platform: "win32",
    arch: "x64",
    env: {
      Path: "C:\\Program Files\\nodejs",
      ProgramFiles: "C:\\Program Files",
      LOCALAPPDATA: "C:\\Users\\李\\AppData\\Local",
      APPDATA: "C:\\Users\\李\\AppData\\Roaming",
      USERPROFILE: "C:\\Users\\李",
      SystemRoot: "C:\\Windows",
    },
    homeDir: "C:\\Users\\李",
    fileSystem,
    executor,
  });

  const seeds = await registry.collect();
  assert.ok(seeds.some((seed) => seed.executable === "C:\\Program Files\\nodejs\\node.exe"));
  assert.ok(seeds.some((seed) => seed.executable === "C:\\Program Files\\Git\\bin\\bash.exe"));
  assert.ok(seeds.some((seed) => seed.executable === "C:\\Users\\李\\scoop\\apps\\ripgrep\\current\\rg.exe"));
  assert.ok(seeds.some((seed) => seed.executable === "C:\\Python312\\python.exe"));
  assert.ok(seeds.some((seed) => seed.executable === "C:\\Registry Python\\python.exe"));
  assert.ok(seeds.some((seed) => seed.executable === "C:\\Tools\\uv.exe"));
  assert.ok(seeds.some((seed) => seed.executable === "C:\\Users\\李\\.bun\\bin\\bun.exe"));
  assert.ok(
    seeds.some(
      (seed) =>
        seed.executable === "C:\\Users\\李\\AppData\\Roaming\\fnm\\node-versions\\v24.18.0\\installation\\node.exe",
    ),
  );
  assert.ok(seeds.some((seed) => seed.executable === "C:\\Users\\李\\miniforge3\\python.exe"));
  assert.ok(seeds.some((seed) => seed.executable === "C:\\Users\\李\\AppData\\Local\\mise\\shims\\node.exe"));
  assert.ok(
    commands.some(
      (command) => command.executable === "C:\\Users\\李\\AppData\\Local\\Programs\\Python\\Launcher\\py.exe",
    ),
  );
  assert.equal(
    commands.some((command) => /(?:powershell|cmd)\.exe$/i.test(command.executable)),
    false,
  );
});

test("parses Python Launcher and PEP 514 paths with spaces and UNC roots", () => {
  assert.deepEqual(
    parsePythonLauncherPaths(
      " -V:3.13 * C:\\Users\\李 User\\Python313\\python.exe\r\n -V:3.12 \\\\server\\Python 312\\python.exe\r\n",
    ),
    ["C:\\Users\\李 User\\Python313\\python.exe", "\\\\server\\Python 312\\python.exe"],
  );
  assert.deepEqual(
    parsePep514ExecutablePaths(
      "ExecutablePath    REG_SZ    C:\\Python 313\\python.exe\r\nExecutablePath REG_EXPAND_SZ \\\\server\\py\\python.exe",
    ),
    ["C:\\Python 313\\python.exe", "\\\\server\\py\\python.exe"],
  );
});

function result(command, stdout, overrides = {}) {
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
    ...overrides,
  };
}
