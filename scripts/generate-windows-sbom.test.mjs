import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

import { createWindowsSbom } from "./generate-windows-sbom.mjs";

function facts() {
  return {
    packageJson: { name: "@dlyzzt/pi-desktop", version: "0.1.13", license: "Apache-2.0" },
    packageLock: {
      lockfileVersion: 3,
      packages: {
        "": {
          name: "@dlyzzt/pi-desktop",
          version: "0.1.13",
          license: "Apache-2.0",
          dependencies: { alpha: "1.0.0" },
          devDependencies: { ignored: "1.0.0" },
          engines: { node: ">=22" },
        },
        "node_modules/alpha": {
          version: "1.0.0",
          license: "MIT",
          integrity: "sha512-YWxwaGE=",
          dependencies: { beta: "2.0.0" },
          optionalDependencies: { darwin: "1.0.0", windows: "1.0.0" },
        },
        "node_modules/beta": { version: "2.0.0", license: "ISC", integrity: "sha256-YmV0YQ==" },
        "node_modules/darwin": { version: "1.0.0", license: "MIT", optional: true, os: ["darwin"] },
        "node_modules/windows": {
          version: "1.0.0",
          license: "Apache-2.0",
          optional: true,
          os: ["win32"],
          cpu: ["x64"],
        },
        "node_modules/ignored": { version: "1.0.0", license: "MIT", dev: true },
      },
    },
    packageLockHash: "1".repeat(64),
    cargoLock: `
[[package]]
name = "pi-windows-managed-process-helper"
version = "0.1.0"

[[package]]
name = "windows-sys"
version = "0.61.2"
checksum = "${"2".repeat(64)}"

[[package]]
name = "windows-link"
version = "0.2.1"
checksum = "${"3".repeat(64)}"
`,
    helperManifest: {
      schemaVersion: 1,
      protocolVersion: 1,
      buildId: "pimpd-0.1.13-p1-abcdef123456",
      arch: "x64",
      provenance: "release-authoritative",
      file: "pi-managed-process-helper.exe",
      sha256: "4".repeat(64),
      sourceRevision: "abcdef123456",
      targetTriple: "x86_64-pc-windows-msvc",
    },
    helperHash: "4".repeat(64),
    helperPackageVersion: "0.1.0",
    coreManifest: {
      schemaVersion: 1,
      platform: "win32",
      arch: "x64",
      tools: [
        {
          componentId: "ripgrep",
          version: "15.2.0",
          sha256: "5".repeat(64),
          artifactSha256: "6".repeat(64),
          bytes: 100,
        },
        {
          componentId: "fd",
          version: "10.3.0",
          sha256: "7".repeat(64),
          artifactSha256: "8".repeat(64),
          bytes: 200,
        },
      ],
    },
    electronPackage: { version: "43.1.1" },
    electronVersions: { electron: "43.1.1", chrome: "150.0.7871.114", node: "24.18.0", v8: "15.0.1" },
    rustToolchain: "1.96.1",
    provenance: {
      rustc: "1.96.1",
      rustcCommit: "a".repeat(40),
      cargo: "1.96.1",
      cargoCommit: "b".repeat(40),
      rustcLlvm: "22.1.2",
      nativeWindowsSdk: "10.0.26100.0",
      nativeMsvcToolset: "14.44.35207",
    },
    installerName: "Pi-Agent-Desktop-Unsigned-Beta-Setup-0.1.13.exe",
    installerHash: "9".repeat(64),
    noticesHash: "a".repeat(64),
  };
}

test("Windows SBOM is deterministic and distinguishes shipped, native-build, and cross-gate components", () => {
  const first = createWindowsSbom(facts());
  const second = createWindowsSbom(facts());
  assert.deepEqual(first, second);
  assert.equal(first.bomFormat, "CycloneDX");
  assert.equal(first.specVersion, "1.5");
  const names = first.components.map((entry) => entry.name);
  for (const name of [
    "alpha",
    "beta",
    "windows",
    "Electron",
    "pi-windows-managed-process-helper",
    "windows-sys",
    "windows-link",
    "ripgrep",
    "fd",
  ]) {
    assert.ok(names.includes(name), name);
  }
  assert.equal(names.includes("darwin"), false);
  assert.equal(names.includes("ignored"), false);
  const tools = new Map(first.metadata.tools.components.map((entry) => [entry.name, entry]));
  assert.equal(tools.get("rustc").version, "1.96.1");
  assert.equal(tools.get("cargo-xwin").scope, "excluded");
  assert.ok(
    first.dependencies
      .find((entry) => entry.ref === "native:managed-process-helper")
      .dependsOn.includes("native:msvc-crt"),
  );
});

test("Windows SBOM fails closed on helper bytes or release provenance drift", () => {
  const tampered = facts();
  tampered.helperHash = "f".repeat(64);
  assert.throws(() => createWindowsSbom(tampered), /manifest does not match/);
  const development = facts();
  development.helperManifest.provenance = "windows-native-dev";
  assert.throws(() => createWindowsSbom(development), /manifest does not match/);
});

test("current production lock includes the complete Pi 0.85 graph in the Windows SBOM", () => {
  const input = facts();
  input.packageLock = JSON.parse(readFileSync(new URL("../package-lock.json", import.meta.url), "utf8"));
  const sbom = createWindowsSbom(input);
  for (const name of [
    "pi-ai",
    "pi-coding-agent",
    "pi-server",
    "pi-agent-core",
    "pi-client",
    "pi-protocol",
    "pi-telemetry",
    "pi-tui",
    "chord",
  ]) {
    const matches = sbom.components.filter((entry) => entry.name === `@earendil-works/${name}`);
    assert.ok(matches.length > 0, name);
    assert.ok(
      matches.every((entry) => entry.version === "0.85.0"),
      name,
    );
  }
});
