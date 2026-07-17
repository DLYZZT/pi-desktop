#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const rawArgs = process.argv.slice(2);
const allowedArgs = new Set(["--notarize", "--arm64", "--x64"]);
const unknownArgs = rawArgs.filter((arg) => !allowedArgs.has(arg));

function fail(message) {
  console.error(`[mac-release] ${message}`);
  process.exit(1);
}

if (unknownArgs.length > 0) {
  fail(`unknown argument${unknownArgs.length === 1 ? "" : "s"}: ${unknownArgs.join(", ")}`);
}

if (process.platform !== "darwin") {
  fail("macOS release builds must run on macOS");
}

const shouldNotarize = rawArgs.includes("--notarize");
const requestedArchitectures = ["arm64", "x64"].filter((arch) => rawArgs.includes(`--${arch}`));
const architectures = requestedArchitectures.length > 0 ? requestedArchitectures : [process.arch];

if (architectures.some((arch) => arch !== "arm64" && arch !== "x64")) {
  fail(`unsupported macOS architecture: ${architectures.join(", ")}`);
}

function hasEnv(name) {
  return typeof process.env[name] === "string" && process.env[name].trim().length > 0;
}

function requireNotarizationCredentials() {
  const strategies = [
    {
      name: "Apple Account app-specific password",
      variables: ["APPLE_ID", "APPLE_APP_SPECIFIC_PASSWORD", "APPLE_TEAM_ID"],
    },
    {
      name: "App Store Connect API key",
      variables: ["APPLE_API_KEY", "APPLE_API_KEY_ID", "APPLE_API_ISSUER"],
    },
    {
      name: "Keychain profile",
      variables: ["APPLE_KEYCHAIN_PROFILE"],
      optionalVariables: ["APPLE_KEYCHAIN"],
    },
  ];

  const configured = strategies.filter((strategy) =>
    [...strategy.variables, ...(strategy.optionalVariables ?? [])].some(hasEnv),
  );
  const incomplete = configured
    .filter((strategy) => !strategy.variables.every(hasEnv))
    .map((strategy) => {
      const missing = strategy.variables.filter((name) => !hasEnv(name));
      return `${strategy.name} is missing ${missing.join(", ")}`;
    });

  if (incomplete.length > 0) {
    fail(`incomplete notarization credentials: ${incomplete.join("; ")}`);
  }

  if (configured.length > 1) {
    fail(
      `multiple notarization credential strategies are configured: ${configured.map(({ name }) => name).join(", ")}`,
    );
  }

  if (configured.length === 1) {
    console.log(`[mac-release] notarization credentials: ${configured[0].name}`);
    return;
  }

  fail(
    "notarization credentials are required; set APPLE_KEYCHAIN_PROFILE, an App Store Connect API key, or Apple Account app-specific-password variables",
  );
}

function run(command, args, env = process.env) {
  console.log(`> ${command} ${args.join(" ")}`);
  const result = spawnSync(command, args, {
    cwd: root,
    env,
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

if (shouldNotarize) requireNotarizationCredentials();

run("npm", ["run", "verify"]);
run(
  "npx",
  [
    "electron-builder",
    "--mac",
    "dmg",
    "zip",
    ...architectures.map((arch) => `--${arch}`),
    "--publish",
    "never",
    "-c.forceCodeSigning=true",
    `-c.mac.notarize=${shouldNotarize}`,
  ],
  {
    ...process.env,
    CSC_IDENTITY_AUTO_DISCOVERY: "true",
  },
);
