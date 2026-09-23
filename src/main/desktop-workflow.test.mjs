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
    stepByName("package", "Verify packaged toolchains and production startup (macOS)").run,
    /check:packaged-toolchains/,
  );
  assert.match(
    stepByName("package", "Verify packaged toolchains and production startup (Windows)").run,
    /check:packaged-toolchains.*--release-helper/,
  );
  assert.match(
    stepByName("package", "Verify packaged toolchains and production startup (Linux)").run,
    /check:packaged-toolchains/,
  );
});

test("Windows runs pure quality checks and Electron smoke without an Xvfb dependency", () => {
  const windows = workflow.jobs["test-platforms"].strategy.matrix.include.find(({ name }) => name === "Windows x64");
  assert.equal(windows.runner, "windows-2025");
  assert.equal(windows.timeout_minutes, 45);
  assert.equal(workflow.jobs["test-platforms"]["timeout-minutes"], "${{ matrix.timeout_minutes }}");
  const helperAcceptance = stepByName("test-platforms", "Validate Windows managed process helper").run;
  assert.match(helperAcceptance, /PI_WINDOWS_HELPER_HANDLE_LOOPS = "100"/);
  assert.match(helperAcceptance, /PSNativeCommandUseErrorActionPreference = \$true/);
  assert.equal(stepByName("test-platforms", "Install Electron binary").if, undefined);

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
  const packageSteps = workflow.jobs.package.steps;
  assert.ok(
    packageSteps.indexOf(stepByName("package", "Prepare verified bundled search tools")) < packageSteps.indexOf(smoke),
    "bundled search tools must be prepared before Electron smoke",
  );
  assert.ok(
    packageSteps.indexOf(stepByName("package", "Rebuild authoritative Windows helper for packaging")) <
      packageSteps.indexOf(stepByName("package", "Package ${{ matrix.name }}")),
    "the authoritative helper must replace the development build before packaging",
  );
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

test("Windows packages and draft releases require an exact CycloneDX SBOM and notices asset", () => {
  for (const jobName of ["package", "release-windows"]) {
    const gate = stepByName(jobName, "Generate and verify Windows SBOM");
    assert.match(gate.run, /npm run build:windows-sbom/);
    assert.match(gate.run, /npm run check:windows-sbom/);
  }
  const windowsUpload = stepByName("release-windows", "Upload Windows release artifacts").with.path;
  assert.match(windowsUpload, /dist\/\*\.cdx\.json/);
  assert.match(windowsUpload, /THIRD_PARTY_NOTICES\.md/);
  const release = stepByName("release", "Create or update draft release").run;
  assert.match(release, /-name '\*\.cdx\.json'/);
  assert.match(release, /-name 'THIRD_PARTY_NOTICES\.md'/);
  assert.match(release, /find "\$windows_artifacts" -type f -name '\*\.cdx\.json'/);
});
