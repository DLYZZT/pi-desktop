#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-browser-harness-build-"));
const outfile = path.join(temp, "browser-electron-harness.cjs");
try {
  const build = spawnSync(
    path.join(root, "node_modules", ".bin", process.platform === "win32" ? "esbuild.cmd" : "esbuild"),
    [
      "src/smoke/browser-electron-harness.ts",
      "--bundle",
      "--platform=node",
      "--format=cjs",
      "--external:electron",
      `--outfile=${outfile}`,
    ],
    { cwd: root, stdio: "inherit" },
  );
  if (build.status !== 0) process.exit(build.status ?? 1);
  const electronBinary = path.join(
    root,
    "node_modules",
    ".bin",
    process.platform === "win32" ? "electron.cmd" : "electron",
  );
  const child = spawn(electronBinary, [outfile], {
    cwd: root,
    stdio: "inherit",
    env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: "true" },
  });
  const status = await new Promise((resolve) => {
    const timer = setTimeout(() => {
      console.error("Browser Electron harness timed out");
      child.kill();
      resolve(1);
    }, 60_000);
    child.once("error", (error) => {
      clearTimeout(timer);
      console.error(error);
      resolve(1);
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      resolve(code ?? 1);
    });
  });
  process.exitCode = status;
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}
