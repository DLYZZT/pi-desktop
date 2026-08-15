#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { buildSync } from "esbuild";
import { resolveElectronBinary, terminateProcessTree } from "./process-utils.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-browser-harness-build-"));
const outfile = path.join(temp, "browser-electron-harness.cjs");
try {
  buildSync({
    absWorkingDir: root,
    entryPoints: ["src/smoke/browser-electron-harness.ts"],
    bundle: true,
    platform: "node",
    format: "cjs",
    external: ["electron"],
    outfile,
    logLevel: "info",
  });
  const electronBinary = resolveElectronBinary(root);
  const child = spawn(electronBinary, [outfile], {
    cwd: root,
    stdio: "inherit",
    detached: process.platform !== "win32",
    env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: "true" },
  });
  const status = await new Promise((resolve) => {
    const timer = setTimeout(() => {
      console.error("Browser Electron harness timed out");
      terminateProcessTree(child);
      resolve(1);
    }, 60_000);
    child.once("error", (error) => {
      clearTimeout(timer);
      console.error(error);
      resolve(1);
    });
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      if (signal) console.error(`Browser Electron harness terminated by signal ${signal}`);
      resolve(code ?? 1);
    });
  });
  process.exitCode = status;
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}
