import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  detectProjectTools,
  nodeVersionSatisfies,
  normalizeNodeRequest,
  normalizePythonVersionRequest,
  pythonVersionSatisfies,
} from "./project-detector.ts";

function withProject(callback) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-project-detector-"));
  try {
    return callback(root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test("parses bounded project declarations without activating an untrusted environment", () =>
  withProject((root) => {
    const cwd = path.join(root, "apps", "api");
    fs.mkdirSync(path.join(root, ".git"));
    fs.mkdirSync(cwd, { recursive: true });
    fs.writeFileSync(path.join(root, ".nvmrc"), "24\n");
    fs.writeFileSync(path.join(root, ".python-version"), "3.12\n");
    fs.writeFileSync(path.join(root, "pyproject.toml"), '[project]\nrequires-python = ">=3.11,<3.15"\n');
    fs.writeFileSync(path.join(root, "uv.lock"), "version = 1\n");
    fs.writeFileSync(path.join(root, "requirements-dev.txt"), "pytest\n");
    fs.writeFileSync(
      path.join(cwd, "package.json"),
      JSON.stringify({ engines: { node: ">=22 <25" }, packageManager: "pnpm@10.0.0" }),
    );
    const venvBin = path.join(cwd, ".venv", process.platform === "win32" ? "Scripts" : "bin");
    fs.mkdirSync(venvBin, { recursive: true });
    const python = path.join(venvBin, process.platform === "win32" ? "python.exe" : "python3");
    fs.symlinkSync(process.execPath, python);

    const blocked = detectProjectTools(cwd, { trusted: false, platform: process.platform, env: {} });
    assert.equal(blocked.root, root);
    assert.equal(blocked.requirements.packageManager, "pnpm");
    assert.equal(blocked.requirements.nodeRange, ">=24.0.0 <25.0.0 && >=22 <25");
    assert.equal(blocked.requirements.pythonRequest, "==3.12.* && >=3.11,<3.15");
    assert.equal(blocked.requirements.pythonEnvironment, path.join(cwd, ".venv"));
    assert.equal(blocked.pythonExecutable, undefined);
    assert.ok(blocked.requirements.markers.includes("python-environment-blocked"));
    assert.ok(blocked.requirements.markers.includes("requirements.txt"));

    const trusted = detectProjectTools(cwd, { trusted: true, platform: process.platform, env: {} });
    assert.equal(trusted.pythonExecutable, python);
    assert.ok(trusted.requirements.markers.includes("python-environment"));
    assert.notEqual(trusted.fingerprint, blocked.fingerprint);
  }));

test("evaluates Node and Python requests without executing version-manager scripts", () => {
  assert.equal(normalizeNodeRequest("v24"), ">=24.0.0 <25.0.0");
  assert.equal(normalizeNodeRequest("24.2"), ">=24.2.0 <24.3.0");
  assert.equal(normalizeNodeRequest("lts/*"), undefined);
  assert.equal(nodeVersionSatisfies("24.18.0", ">=24 <25 && >=22"), true);
  assert.equal(nodeVersionSatisfies("22.19.0", ">=24 <25"), false);

  assert.equal(normalizePythonVersionRequest("cpython-3.12.7"), "==3.12.7");
  assert.equal(normalizePythonVersionRequest("3.11"), "==3.11.*");
  assert.equal(pythonVersionSatisfies("3.12.7", "==3.12.* && >=3.10,<3.14"), true);
  assert.equal(pythonVersionSatisfies("3.14.0", "~=3.12"), true);
  assert.equal(pythonVersionSatisfies("4.0.0", "~=3.12"), false);
  assert.equal(pythonVersionSatisfies("3.12.7", "!=3.12.7"), false);
});

test("ignores project data symlinks and virtual environments outside the project root", () =>
  withProject((root) => {
    fs.mkdirSync(path.join(root, ".git"));
    const external = fs.mkdtempSync(path.join(os.tmpdir(), "pi-external-environment-"));
    try {
      fs.writeFileSync(path.join(external, "package.json"), JSON.stringify({ engines: { node: "999" } }));
      fs.symlinkSync(path.join(external, "package.json"), path.join(root, "package.json"));
      const detected = detectProjectTools(root, {
        trusted: true,
        platform: process.platform,
        env: { VIRTUAL_ENV: external },
      });
      assert.equal(detected.requirements.nodeRange, undefined);
      assert.equal(detected.requirements.pythonEnvironment, undefined);
      assert.equal(detected.pythonExecutable, undefined);
    } finally {
      fs.rmSync(external, { recursive: true, force: true });
    }
  }));
