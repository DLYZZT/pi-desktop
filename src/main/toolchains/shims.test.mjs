import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createToolchainPaths } from "./paths.ts";
import { ensurePythonShims } from "./shims.ts";

function descriptor(executable) {
  return {
    capability: "python.interpreter",
    provider: "managed",
    executable,
    argvPrefix: [],
    binDir: path.dirname(executable),
    cwdSemantics: "native",
    envPatch: {},
  };
}

test("creates and repairs private POSIX python/python3 aliases", { skip: process.platform === "win32" }, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-python-shims-"));
  try {
    const paths = createToolchainPaths(root);
    const directory = ensurePythonShims({ paths, descriptor: descriptor(process.execPath), platform: "darwin" });
    for (const name of ["python", "python3"]) {
      assert.equal(fs.readlinkSync(path.join(directory, name)), process.execPath);
    }
    fs.unlinkSync(path.join(directory, "python"));
    fs.writeFileSync(path.join(directory, "python"), "tampered");
    assert.equal(ensurePythonShims({ paths, descriptor: descriptor(process.execPath), platform: "darwin" }), directory);
    assert.equal(fs.readlinkSync(path.join(directory, "python")), process.execPath);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("creates native cmd and Git Bash aliases for Windows paths", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-python-windows-shims-"));
  try {
    const paths = createToolchainPaths(root);
    const executable = "C:\\Tools & 100%\\Python\\python.exe";
    const directory = ensurePythonShims({ paths, descriptor: descriptor(executable), platform: "win32" });
    assert.match(fs.readFileSync(path.join(directory, "python.cmd"), "utf8"), /100%%/);
    assert.match(fs.readFileSync(path.join(directory, "python"), "utf8"), /C:\/Tools & 100%\/Python\/python\.exe/);
    assert.equal(ensurePythonShims({ paths, descriptor: descriptor(executable), platform: "win32" }), directory);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
