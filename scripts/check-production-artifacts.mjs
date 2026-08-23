#!/usr/bin/env node
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const mainBundle = readFileSync(path.join(root, "out", "main", "main.js"), "utf8");
const agentHostBundle = readFileSync(path.join(root, "out", "main", "agent-host.mjs"), "utf8");
const builderConfig = readFileSync(path.join(root, "electron-builder.yml"), "utf8");
const packageJson = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
const packageLock = JSON.parse(readFileSync(path.join(root, "package-lock.json"), "utf8"));
const updaterVersion = packageJson.dependencies?.["electron-updater"];
const lockedUpdaterVersion = packageLock.packages?.["node_modules/electron-updater"]?.version;
const updaterDependencyIsValid =
  typeof updaterVersion === "string" &&
  /^\d+\.\d+\.\d+$/.test(updaterVersion) &&
  updaterVersion === lockedUpdaterVersion &&
  packageJson.devDependencies?.["electron-updater"] === undefined;
const requiredMainMarkers = [
  "electron-updater",
  "update:state",
  "desktop:update:check",
  "--validate-packaged-startup",
  "packaged-startup-check.json",
  "pi-managed-process-helper.exe",
  "--version-json-v1",
  "--reap-stdio-v1",
];
const requiredAgentHostMarkers = ["--owner-stdio-v1", "JOB_TERMINATE"];
const missingMainMarkers = requiredMainMarkers.filter((marker) => !mainBundle.includes(marker));
const missingAgentHostMarkers = requiredAgentHostMarkers.filter((marker) => !agentHostBundle.includes(marker));
const forbiddenMarkers = [
  "runSmokeHostChecks",
  "Smoke RPC timed out",
  "pi-desktop-smoke-",
  "PI_SMOKE_TEST",
  "dev-app-update.yml",
  "setFeedURL",
  "GH_TOKEN",
  "MAC_CSC_LINK",
  "APPLE_APP_SPECIFIC_PASSWORD",
];
const found = forbiddenMarkers.filter((marker) => mainBundle.includes(marker));
const leakedCredentials = [
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/,
  /\bgh[pousr]_[A-Za-z0-9_]{20,}\b/,
  /\bnpm_[A-Za-z0-9]{20,}\b/,
].filter((pattern) => pattern.test(mainBundle));
const requiredPackageExclusions = [
  '"!**/*.map"',
  '"!**/*.{md,markdown,ts,tsx}"',
  '"!**/*.d.{mts,cts}"',
  '"!node_modules/@earendil-works/pi-coding-agent/docs/**/*"',
  '"!node_modules/@earendil-works/pi-coding-agent/examples/**/*"',
];
const missingPackageExclusions = requiredPackageExclusions.filter((pattern) => !builderConfig.includes(pattern));
const requiredPiAuthoringAssetMarkers = [
  "from: node_modules/@earendil-works/pi-coding-agent",
  "to: node_modules/@earendil-works/pi-coding-agent",
  "- README.md",
  '- "docs/**/*"',
  '- "examples/**/*"',
  '- "dist/**/*.d.ts"',
  "from: node_modules/@earendil-works/pi-ai/dist",
  "to: node_modules/@earendil-works/pi-ai/dist",
  "from: node_modules/@earendil-works/pi-telemetry",
  "to: node_modules/@earendil-works/pi-telemetry",
  "from: node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-ai",
  "to: node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-ai",
  "from: node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-tui",
  "to: node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-tui",
  "from: node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-client",
  "to: node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-client",
  "from: node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-protocol",
  "to: node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-protocol",
  "from: node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-telemetry",
  "to: node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-telemetry",
  "- CHANGELOG.md",
  "- package.json",
  '- "dist/**/*.js"',
  '- "dist/**/*.json"',
  '- "**/*.d.ts"',
  '- "dist/**/*.d.ts"',
  '- "native/**/*"',
];
const missingPiAuthoringAssets = requiredPiAuthoringAssetMarkers.filter((marker) => !builderConfig.includes(marker));
const toolchainCatalogPackagingIsValid =
  builderConfig.includes("from: THIRD_PARTY_NOTICES.md") &&
  builderConfig.includes("to: THIRD_PARTY_NOTICES.md") &&
  builderConfig.includes("from: build/toolchains/runtime-catalog.json") &&
  builderConfig.includes("to: toolchains/runtime-catalog.json") &&
  builderConfig.includes("from: build/toolchains/core-catalog.json") &&
  builderConfig.includes("to: toolchains/core-catalog.json") &&
  builderConfig.includes("from: build/toolchains/core/${platform}-${arch}") &&
  builderConfig.includes("to: toolchains/core/${platform}-${arch}") &&
  builderConfig.includes("executableName: pi-agent-desktop") &&
  !/from:\s*build\/toolchains\/(?:archives|downloads|runtimes)/i.test(builderConfig);
const windowsHelperPackagingIsValid =
  builderConfig.includes("from: out/native/windows-managed-process-helper") &&
  builderConfig.includes("to: managed-process/win32-x64") &&
  builderConfig.includes("pi-managed-process-helper.exe") &&
  builderConfig.includes("manifest.json");

if (
  !updaterDependencyIsValid ||
  !toolchainCatalogPackagingIsValid ||
  !windowsHelperPackagingIsValid ||
  missingMainMarkers.length > 0 ||
  missingAgentHostMarkers.length > 0 ||
  found.length > 0 ||
  leakedCredentials.length > 0 ||
  missingPackageExclusions.length > 0 ||
  missingPiAuthoringAssets.length > 0
) {
  if (!updaterDependencyIsValid) {
    console.error("FAIL: electron-updater must be an exact production dependency matching package-lock.json");
  }
  for (const marker of missingMainMarkers) {
    console.error(`FAIL: production main bundle is missing required marker: ${marker}`);
  }
  for (const marker of missingAgentHostMarkers) {
    console.error(`FAIL: production Agent Host bundle is missing required marker: ${marker}`);
  }
  for (const marker of found) console.error(`FAIL: production main bundle contains forbidden marker: ${marker}`);
  for (const pattern of leakedCredentials) {
    console.error(`FAIL: production main bundle contains a credential matching ${pattern}`);
  }
  for (const pattern of missingPackageExclusions) {
    console.error(`FAIL: electron-builder.yml is missing production exclusion: ${pattern}`);
  }
  for (const pattern of missingPiAuthoringAssets) {
    console.error(`FAIL: electron-builder.yml is missing Pi authoring asset: ${pattern}`);
  }
  if (!toolchainCatalogPackagingIsValid) {
    console.error(
      "FAIL: production packaging must include third-party notices, fixed catalogs, and only target-specific bundled core tools",
    );
  }
  if (!windowsHelperPackagingIsValid) {
    console.error("FAIL: Windows packages must include exactly the fixed helper executable and integrity manifest");
  }
  process.exit(1);
}

console.log(
  `OK: electron-updater ${updaterVersion} is locked for production; main and Agent Host bundles contain ${requiredMainMarkers.length + requiredAgentHostMarkers.length} required markers, main excludes ${forbiddenMarkers.length} forbidden markers, packaging retains ${requiredPackageExclusions.length} source exclusions and explicit Pi authoring asset FileSets, and fixed catalogs plus target-specific core tools are packaged without managed runtime archives`,
);
