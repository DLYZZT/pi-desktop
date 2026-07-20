#!/usr/bin/env node
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const mainBundle = readFileSync(path.join(root, "out", "main", "main.js"), "utf8");
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
const requiredMarkers = [
  "electron-updater",
  "update:state",
  "desktop:update:check",
  "--validate-packaged-startup",
  "packaged-startup-check.json",
];
const missing = requiredMarkers.filter((marker) => !mainBundle.includes(marker));
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
const requiredPackageExclusions = ['"!**/*.map"', '"!**/*.{md,markdown,ts,tsx}"', '"!**/*.d.{mts,cts}"'];
const missingPackageExclusions = requiredPackageExclusions.filter((pattern) => !builderConfig.includes(pattern));
const toolchainCatalogPackagingIsValid =
  builderConfig.includes("from: build/THIRD_PARTY_NOTICES.md") &&
  builderConfig.includes("to: THIRD_PARTY_NOTICES.md") &&
  builderConfig.includes("from: build/toolchains/runtime-catalog.json") &&
  builderConfig.includes("to: toolchains/runtime-catalog.json") &&
  builderConfig.includes("from: build/toolchains/core-catalog.json") &&
  builderConfig.includes("to: toolchains/core-catalog.json") &&
  builderConfig.includes("from: build/toolchains/core/${platform}-${arch}") &&
  builderConfig.includes("to: toolchains/core/${platform}-${arch}") &&
  builderConfig.includes("executableName: pi-agent-desktop") &&
  !/from:\s*build\/toolchains\/(?:archives|downloads|runtimes)/i.test(builderConfig);

if (
  !updaterDependencyIsValid ||
  !toolchainCatalogPackagingIsValid ||
  missing.length > 0 ||
  found.length > 0 ||
  leakedCredentials.length > 0 ||
  missingPackageExclusions.length > 0
) {
  if (!updaterDependencyIsValid) {
    console.error("FAIL: electron-updater must be an exact production dependency matching package-lock.json");
  }
  for (const marker of missing) console.error(`FAIL: production main bundle is missing updater marker: ${marker}`);
  for (const marker of found) console.error(`FAIL: production main bundle contains forbidden marker: ${marker}`);
  for (const pattern of leakedCredentials) {
    console.error(`FAIL: production main bundle contains a credential matching ${pattern}`);
  }
  for (const pattern of missingPackageExclusions) {
    console.error(`FAIL: electron-builder.yml is missing production exclusion: ${pattern}`);
  }
  if (!toolchainCatalogPackagingIsValid) {
    console.error(
      "FAIL: production packaging must include third-party notices, fixed catalogs, and only target-specific bundled core tools",
    );
  }
  process.exit(1);
}

console.log(
  `OK: electron-updater ${updaterVersion} is locked for production; main bundle contains ${requiredMarkers.length} updater markers, excludes ${forbiddenMarkers.length} forbidden markers, packaging retains ${requiredPackageExclusions.length} source exclusions, and fixed catalogs plus target-specific core tools are packaged without managed runtime archives`,
);
