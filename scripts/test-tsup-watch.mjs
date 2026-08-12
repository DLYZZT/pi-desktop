#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "tsup";
import configs from "../tsup.config.ts";
import { assertSuccessfulSpawn } from "./process-utils.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outputGroups = [
  ["out/main/main.js", "out/main/main.js.map"],
  [
    "out/main/agent-host.mjs",
    "out/main/agent-host.mjs.map",
    "out/main/plugin-worker.mjs",
    "out/main/plugin-worker.mjs.map",
  ],
  ["out/preload/preload.js", "out/preload/preload.js.map"],
].map((group) => group.map((file) => path.join(root, file)));

function digest(file) {
  return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

assertSuccessfulSpawn(
  spawnSync(process.execPath, [path.join(root, "scripts", "build-main.mjs")], {
    cwd: root,
    stdio: "inherit",
  }),
  "initial main build",
);

if (!Array.isArray(configs) || configs.length !== outputGroups.length) {
  throw new Error(`expected ${outputGroups.length} tsup sub-configs`);
}

for (const [index, config] of configs.entries()) {
  if (config.clean !== false) throw new Error(`tsup sub-config ${index} must not clean shared watch outputs`);
  const preservedGroups = outputGroups.filter((_, groupIndex) => groupIndex !== index);
  const before = new Map(preservedGroups.flat().map((file) => [file, digest(file)]));

  await build({ ...config, config: false, watch: false });

  for (const group of outputGroups) {
    for (const file of group) {
      if (!fs.existsSync(file)) throw new Error(`sub-config ${index} removed ${path.relative(root, file)}`);
    }
  }
  for (const [file, expectedDigest] of before) {
    if (digest(file) !== expectedDigest) {
      throw new Error(`sub-config ${index} unexpectedly rewrote ${path.relative(root, file)}`);
    }
  }
}

console.log("[build-watch] every isolated main, host, and preload rebuild preserved the other output groups");
