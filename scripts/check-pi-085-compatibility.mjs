#!/usr/bin/env node
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { validatePiPackageGraph, probePiRuntime } from "./pi-runtime-contract.mjs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const targetVersion = "0.85.0";
// pi-server is temporary: 0.85.0's public SDK imports it without declaring it (#9132).
const directPackages = [
  "@earendil-works/pi-ai",
  "@earendil-works/pi-coding-agent",
  "@earendil-works/pi-server",
  "@earendil-works/pi-telemetry",
];

function fail(message) {
  console.error(`[pi-085-compat] ${message}`);
  process.exit(1);
}

function readJson(relativePath) {
  return JSON.parse(readFileSync(path.join(root, relativePath), "utf8"));
}

const packageJson = readJson("package.json");
const lockfile = readJson("package-lock.json");
const graph = validatePiPackageGraph({
  readPackage: readJson,
  exists: (entry) => existsSync(path.join(root, entry)),
  version: targetVersion,
});
for (const [entry, version] of graph) {
  if (lockfile.packages?.[entry]?.version !== version) fail(`installed Pi package differs from lockfile: ${entry}`);
}
for (const [entry, metadata] of Object.entries(lockfile.packages ?? {})) {
  if (/node_modules\/@earendil-works\/(?:pi-[^/]+|chord)$/.test(entry) && metadata.version !== targetVersion)
    fail(`mixed Pi lockfile version: ${entry}`);
}
probePiRuntime(
  root,
  path.join(
    root,
    "node_modules/@earendil-works/pi-coding-agent",
    readJson("node_modules/@earendil-works/pi-coding-agent/package.json").bin.pi,
  ),
  targetVersion,
);
for (const packageName of directPackages) {
  if (packageJson.dependencies?.[packageName] !== targetVersion) {
    fail(`${packageName} must be pinned exactly to ${targetVersion}`);
  }
  if (lockfile.packages?.[""]?.dependencies?.[packageName] !== targetVersion) {
    fail(`lockfile root dependency ${packageName} must be ${targetVersion}`);
  }
  const installed = readJson(`node_modules/${packageName}/package.json`).version;
  if (installed !== targetVersion) fail(`installed ${packageName} is ${installed}, expected ${targetVersion}`);
}
if (packageJson.overrides?.["@earendil-works/pi-telemetry"] !== targetVersion) {
  fail(`@earendil-works/pi-telemetry override must be ${targetVersion}`);
}
if (packageJson.dependencies?.["@earendil-works/pi-telemetry"] !== targetVersion) {
  fail(`@earendil-works/pi-telemetry must be an exact root dependency at ${targetVersion}`);
}
const telemetryLocks = Object.entries(lockfile.packages ?? {}).filter(([packagePath]) =>
  packagePath.endsWith("node_modules/@earendil-works/pi-telemetry"),
);
if (telemetryLocks.length === 0 || telemetryLocks.some(([, entry]) => entry.version !== targetVersion)) {
  fail(`every locked @earendil-works/pi-telemetry instance must be ${targetVersion}`);
}
if (lockfile.packages?.["node_modules/@earendil-works/pi-telemetry"]?.version !== targetVersion) {
  fail(`the root @earendil-works/pi-telemetry lock entry must be ${targetVersion}`);
}

function sourceFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(absolute);
    return /\.(?:ts|tsx)$/.test(entry.name) && !entry.name.endsWith(".d.ts") ? [absolute] : [];
  });
}

const forbidden = [
  ["removed GoogleThinkingLevel", /\bGoogleThinkingLevel\b/],
  ["removed createGatewayBindingFetch", /\bcreateGatewayBindingFetch\s*\(/],
  ["removed ModelRuntime.reloadConfig", /\.reloadConfig\s*\(/],
  ["removed ModelsStreamTransforms", /\bModelsStreamTransforms\b/],
  ["removed TypeBox helper", /\bType\.(?:Base|Awaited|Promise|AsyncIterator|Iterator|Options)\s*\(/],
  ["removed Value.Mutate", /\bValue\.Mutate\s*\(/],
  ["legacy extension context.store", /\bcontext\.store\b/],
];
for (const file of [
  ...sourceFiles(path.join(root, "src")),
  path.join(root, "vite.config.ts"),
  path.join(root, "tsup.config.ts"),
]) {
  const source = readFileSync(file, "utf8");
  for (const [label, pattern] of forbidden) {
    if (pattern.test(source)) fail(`${label} found in ${path.relative(root, file)}`);
  }
  if (/0\.80\.(?:0|10)/.test(source)) fail(`stale Pi version fallback found in ${path.relative(root, file)}`);
}

const requiredMarkers = [
  ["src/agent-host/model-runtime.ts", "allowNetwork: true"],
  ["src/agent-host/model-runtime.ts", "allowNetwork: false"],
  ["src/contract/api.ts", '"models.refresh"'],
  ["src/contract/api.ts", '"models.refreshCancel"'],
  ["src/agent-host/credential-sync.ts", "recoverCommittedCredential"],
  ["src/renderer/lib/models-config-state.ts", "samplingParams"],
  ["src/agent-host/rpc-manager.ts", "services.diagnostics"],
  ["src/agent-host/rpc-manager.ts", "excludeTools: [...EXCLUDED_PI_TOOLS]"],
  ["src/agent-host/session-readonly.ts", "SessionManager.inMemory"],
];
for (const [relativePath, marker] of requiredMarkers) {
  if (!readFileSync(path.join(root, relativePath), "utf8").includes(marker)) {
    fail(`${relativePath} is missing required marker ${JSON.stringify(marker)}`);
  }
}

console.log(
  `[pi-085-compat] exact dependencies, removed APIs, model refresh, credential/config, and extension diagnostics passed (${targetVersion})`,
);
