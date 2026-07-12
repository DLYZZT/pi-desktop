#!/usr/bin/env node
import { readdirSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sourceRoot = path.join(root, "src");

function collectTests(directory) {
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...collectTests(absolute));
    else if (entry.isFile() && entry.name.endsWith(".test.mjs")) files.push(absolute);
  }
  return files;
}

const tests = collectTests(sourceRoot).sort();
if (tests.length === 0) {
  console.error("No test files found under src/");
  process.exit(1);
}

const result = spawnSync(process.execPath, ["--disable-warning=MODULE_TYPELESS_PACKAGE_JSON", "--test", ...tests], {
  cwd: root,
  stdio: "inherit",
});

process.exit(result.status ?? 1);
