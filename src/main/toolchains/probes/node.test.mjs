import assert from "node:assert/strict";
import test from "node:test";
import { probeNodeDistribution } from "./node.ts";

function seed(executable = "/opt/homebrew/opt/node@22/bin/node") {
  return {
    capability: "js.node",
    provider: "system",
    discovery: "homebrew-formula:node@22",
    executable,
    argvPrefix: [],
    binDir: "/opt/homebrew/opt/node@22/bin",
    rank: 1000,
  };
}

function fileSystem(files) {
  const set = new Set(files);
  return {
    isFile: (filePath) => set.has(filePath),
    isDirectory: () => false,
    readDirectoryNames: () => [],
    realpath: (filePath) => filePath,
  };
}

function success(command, stdout) {
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

test("pairs Homebrew Node, npm, and npx through one absolute Node executable", async () => {
  const node = "/opt/homebrew/Cellar/node@22/22.19.0/bin/node";
  const npm = "/opt/homebrew/opt/node@22/lib/node_modules/npm/bin/npm-cli.js";
  const npx = "/opt/homebrew/opt/node@22/lib/node_modules/npm/bin/npx-cli.js";
  const commands = [];
  const candidates = await probeNodeDistribution(seed(), {
    platform: "darwin",
    arch: "arm64",
    env: { PATH: "/usr/bin" },
    fileSystem: fileSystem([seed().executable, node, npm, npx]),
    executor: {
      async run(command) {
        commands.push(command);
        if (command.args.includes("-e")) {
          return success(
            command,
            JSON.stringify({ execPath: node, versions: { node: "22.19.0" }, arch: "arm64", platform: "darwin" }),
          );
        }
        return success(command, "10.9.3\n");
      },
    },
  });

  assert.deepEqual(
    candidates.map((candidate) => [candidate.capability, candidate.health]),
    [
      ["js.node", "healthy"],
      ["js.npm", "healthy"],
      ["js.npx", "healthy"],
    ],
  );
  assert.equal(candidates[1].executable, node);
  assert.deepEqual(candidates[1].argvPrefix, [npm]);
  assert.deepEqual(candidates[2].argvPrefix, [npx]);
  assert.equal(
    candidates.every((candidate) => candidate.componentRoot === "/opt/homebrew/Cellar/node@22/22.19.0"),
    true,
  );
  assert.equal(
    commands.every((command) => command.executable === seed().executable || command.executable === node),
    true,
  );
});

test("reports npm and npx as incomplete instead of claiming Node is missing", async () => {
  const nodeSeed = seed("/usr/local/bin/node");
  nodeSeed.binDir = "/usr/local/bin";
  const candidates = await probeNodeDistribution(nodeSeed, {
    platform: "darwin",
    arch: "x64",
    env: { PATH: "/usr/bin" },
    fileSystem: fileSystem([nodeSeed.executable]),
    executor: {
      async run(command) {
        return success(
          command,
          JSON.stringify({
            execPath: nodeSeed.executable,
            versions: { node: "22.19.0" },
            arch: "x64",
            platform: "darwin",
          }),
        );
      },
    },
  });

  assert.equal(candidates[0].health, "healthy");
  assert.equal(candidates[1].health, "incomplete");
  assert.equal(candidates[1].reasonCode, "TOOLCHAIN_INCOMPLETE");
  assert.equal(candidates[2].health, "incomplete");
});

test("classifies old and unknown-future Node versions without selecting them", async () => {
  for (const [version, expectedHealth] of [
    ["20.19.0", "unsupported"],
    ["26.0.0", "unverified"],
  ]) {
    const nodeSeed = seed("/usr/bin/node");
    nodeSeed.binDir = "/usr/bin";
    const candidates = await probeNodeDistribution(nodeSeed, {
      platform: "linux",
      arch: "x64",
      env: { PATH: "/usr/bin" },
      fileSystem: fileSystem([nodeSeed.executable]),
      executor: {
        async run(command) {
          return success(
            command,
            JSON.stringify({
              execPath: nodeSeed.executable,
              versions: { node: version },
              arch: "x64",
              platform: "linux",
            }),
          );
        },
      },
    });
    assert.equal(candidates[0].health, expectedHealth);
  }
});

test("rejects mismatched platform or architecture while retaining a lower-priority Rosetta candidate", async () => {
  const nodeSeed = seed("/usr/local/bin/node");
  nodeSeed.binDir = "/usr/local/bin";
  for (const [platform, arch] of [
    ["linux", "arm64"],
    ["win32", "x64"],
  ]) {
    const candidates = await probeNodeDistribution(nodeSeed, {
      platform: "linux",
      arch: "x64",
      env: {},
      fileSystem: fileSystem([nodeSeed.executable]),
      executor: {
        async run(command) {
          return success(
            command,
            JSON.stringify({
              execPath: nodeSeed.executable,
              versions: { node: "24.18.0" },
              arch,
              platform,
            }),
          );
        },
      },
    });
    assert.equal(candidates.length, 1);
    assert.equal(candidates[0].health, "broken");
  }

  const rosetta = await probeNodeDistribution(nodeSeed, {
    platform: "darwin",
    arch: "arm64",
    env: {},
    fileSystem: fileSystem([nodeSeed.executable]),
    executor: {
      async run(command) {
        return success(
          command,
          JSON.stringify({
            execPath: nodeSeed.executable,
            versions: { node: "24.18.0" },
            arch: "x64",
            platform: "darwin",
          }),
        );
      },
    },
  });
  assert.equal(rosetta[0].health, "healthy");
  assert.equal(rosetta[0].rank, nodeSeed.rank + 10_000);
});
