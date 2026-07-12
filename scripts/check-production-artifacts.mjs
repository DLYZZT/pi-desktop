#!/usr/bin/env node
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const mainBundle = readFileSync(path.join(root, "out", "main", "main.js"), "utf8");
const forbiddenMarkers = ["runSmokeHostChecks", "Smoke RPC timed out", "pi-desktop-smoke-", "PI_SMOKE_TEST"];
const found = forbiddenMarkers.filter((marker) => mainBundle.includes(marker));

if (found.length > 0) {
  for (const marker of found) console.error(`FAIL: production main bundle contains smoke marker: ${marker}`);
  process.exit(1);
}

console.log(`OK: production main bundle excludes ${forbiddenMarkers.length} smoke markers`);
