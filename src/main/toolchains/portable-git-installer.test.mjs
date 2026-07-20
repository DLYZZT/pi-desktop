import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { extractPortableGitSfx } from "./portable-git-installer.ts";

function successfulResult(command) {
  return {
    executable: command.executable,
    args: command.args,
    exitCode: 0,
    signal: null,
    stdout: "",
    stderr: "",
    timedOut: false,
    outputLimitExceeded: false,
    durationMs: 1,
  };
}

test("runs only the verified PortableGit SFX with fixed non-elevated staging arguments", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-portable-git-sfx-"));
  try {
    const artifact = path.join(root, "PortableGit.7z.exe");
    const destination = path.join(root, "staging");
    fs.writeFileSync(artifact, "verified artifact");
    let command;
    await extractPortableGitSfx(artifact, destination, {
      platform: "win32",
      env: { SystemRoot: "C:\\Windows" },
      verifyAuthenticode: async () => "valid",
      executor: {
        async run(value) {
          command = value;
          fs.mkdirSync(path.join(destination, "cmd"), { recursive: true });
          fs.mkdirSync(path.join(destination, "bin"), { recursive: true });
          fs.writeFileSync(path.join(destination, "cmd", "git.exe"), "git");
          fs.writeFileSync(path.join(destination, "bin", "bash.exe"), "bash");
          return successfulResult(value);
        },
      },
    });
    assert.equal(command.executable, artifact);
    assert.deepEqual(command.args, ["-y", `-o${destination}`]);
    assert.equal(command.cwd, root);
    assert.ok(command.env.TEMP.startsWith(destination));
    assert.equal(fs.existsSync(`${destination}.sfx-temp`), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("rejects invalid Authenticode before executing the PortableGit artifact", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-portable-git-signature-"));
  try {
    const artifact = path.join(root, "PortableGit.7z.exe");
    const destination = path.join(root, "staging");
    fs.writeFileSync(artifact, "verified artifact");
    let executions = 0;
    await assert.rejects(
      extractPortableGitSfx(artifact, destination, {
        platform: "win32",
        env: {},
        verifyAuthenticode: async () => "invalid",
        executor: {
          async run(value) {
            executions += 1;
            return successfulResult(value);
          },
        },
      }),
      /Authenticode signature is invalid/,
    );
    assert.equal(executions, 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
