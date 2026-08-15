import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import YAML from "yaml";

const root = path.resolve(import.meta.dirname, "../..");
const workflowPath = path.join(root, ".github", "workflows", "build-desktop.yml");
const workflowSource = fs.readFileSync(workflowPath, "utf8");
const workflow = YAML.parse(workflowSource);

function stepByName(jobName, stepName) {
  const step = workflow.jobs[jobName].steps.find((candidate) => candidate.name === stepName);
  assert.ok(step, `${jobName} is missing step: ${stepName}`);
  return step;
}

test("main pushes package every supported desktop target", () => {
  assert.deepEqual(workflow.on.push.branches, ["main"]);
  assert.equal(workflow.jobs.package.if, "github.ref_type != 'tag'");
  assert.deepEqual(
    workflow.jobs.package.strategy.matrix.include.map(({ tool_target }) => tool_target),
    ["darwin-arm64", "darwin-x64", "win32-x64", "linux-x64"],
  );
  assert.match(
    stepByName("package", "Verify packaged toolchains and production startup").run,
    /check:packaged-toolchains/,
  );
  assert.match(
    stepByName("package", "Verify packaged toolchains and production startup (Linux)").run,
    /check:packaged-toolchains/,
  );
});

test("Windows runs pure quality checks and Electron smoke without an Xvfb dependency", () => {
  const windows = workflow.jobs["test-platforms"].strategy.matrix.include.find(({ name }) => name === "Windows x64");
  assert.equal(windows.runner, "windows-2025");

  const quality = stepByName("test-platforms", "Run cross-platform quality checks (Windows)");
  assert.equal(quality.if, "runner.os == 'Windows'");
  for (const command of [
    "format:check",
    "lint",
    "typecheck",
    "check:dependencies",
    "check:contract",
    "check:pi-compat",
    "check:toolchain-contract",
    "check:toolchain-catalog",
    "check:browser-i18n",
  ]) {
    assert.match(quality.run, new RegExp(`npm run ${command.replace(":", "\\:")}`));
  }
  assert.doesNotMatch(quality.run, /xvfb/i);

  const smoke = stepByName("package", "Run Electron smoke on Windows");
  assert.equal(smoke.if, "runner.os == 'Windows'");
  assert.equal(smoke.run, "npm run smoke");
});

test("package metadata is cross-checked against each platform artifact", () => {
  const verification = stepByName("package", "Verify update metadata matches the packaged architecture").run;
  for (const metadata of ["latest-mac.yml", "latest.yml", "latest-linux.yml"])
    assert.match(verification, new RegExp(metadata));
  for (const artifact of [
    "${{ matrix.arch }}.dmg",
    "${{ matrix.arch }}.zip",
    "Unsigned-Beta-Setup-${version}.exe",
    "x86_64.AppImage",
  ]) {
    assert.ok(verification.includes(artifact), artifact);
  }
  assert.match(verification, /verify-update-metadata\.mjs "\$metadata" "\$version" "\$\{update_artifacts\[@\]\}"/);
});

test("unsigned Windows releases remain explicitly Beta until Authenticode provenance exists", () => {
  const windowsRelease = workflow.jobs["release-windows"];
  assert.match(windowsRelease.name, /Unsigned Beta/);
  assert.equal(windowsRelease.env.CSC_IDENTITY_AUTO_DISCOVERY, "false");

  const trustGate = stepByName("release-windows", "Enforce unsigned Windows Beta trust status");
  assert.equal(trustGate.shell, "pwsh");
  assert.match(trustGate.run, /Get-AuthenticodeSignature/);
  assert.match(trustGate.run, /NotSigned/);
  assert.match(trustGate.run, /Unknown Publisher/);
  assert.match(trustGate.run, /certificate-backed signing and provenance verification/);

  const builderConfig = fs.readFileSync(path.join(root, "electron-builder.yml"), "utf8");
  assert.match(builderConfig, /artifactName: Pi-Agent-Desktop-Unsigned-Beta-Setup-\$\{version\}\.\$\{ext\}/);
});
