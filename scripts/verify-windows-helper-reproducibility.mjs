#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const manifestPath = path.join(root, "native", "windows-managed-process-helper", "Cargo.toml");
const output = path.join(root, "out", "native", "windows-managed-process-helper", "pi-managed-process-helper.exe");

function run(command, args, label) {
  const result = spawnSync(command, args, { cwd: root, stdio: "inherit", shell: false });
  if (result.error) throw new Error(`${label} failed to start: ${result.error.message}`);
  if (result.signal) throw new Error(`${label} terminated by ${result.signal}`);
  if (result.status !== 0) throw new Error(`${label} exited with status ${result.status ?? "unknown"}`);
}

function hashOutput() {
  return createHash("sha256").update(fs.readFileSync(output)).digest("hex");
}

if (process.platform !== "win32" || process.arch !== "x64") {
  console.log("[windows-helper-reproducibility] skipped: Windows x64 native linker required");
  process.exit(0);
}

run(process.execPath, ["scripts/build-windows-managed-helper.mjs", "--release"], "first release build");
const first = hashOutput();
run(
  "cargo",
  [
    "clean",
    "--manifest-path",
    manifestPath,
    "--release",
    "--target",
    "x86_64-pc-windows-msvc",
    "-p",
    "pi-windows-managed-process-helper",
  ],
  "targeted Cargo clean",
);
run(process.execPath, ["scripts/build-windows-managed-helper.mjs", "--release"], "fresh release build");
const second = hashOutput();
if (first !== second) throw new Error(`Windows helper is not reproducible: first=${first} second=${second}`);
console.log(`[windows-helper-reproducibility] sha256=${second}`);
