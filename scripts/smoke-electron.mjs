#!/usr/bin/env node
/**
 * Smoke test: launch Electron and a hidden renderer, connect to the Host over
 * MessagePort, and verify
 * ping, sessions, Worktree conflict handling, Git status, directory watching,
 * exact binary download, and safe Skill editing.
 */
import { spawn, spawnSync } from "child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "path";
import { fileURLToPath } from "url";
import {
  assertSuccessfulSpawn,
  resolveElectronBinary,
  resolvePackageFile,
  terminateProcessTree,
} from "./process-utils.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const main = path.join(root, ".artifacts", "smoke", "main.js");

const tsupCli = resolvePackageFile(root, "tsup", "dist/cli-default.js");
assertSuccessfulSpawn(
  spawnSync(process.execPath, [tsupCli, "--config", "tsup.smoke.config.ts"], { cwd: root, stdio: "inherit" }),
  "smoke build",
);

if (!existsSync(main)) {
  console.error(`Smoke build did not produce ${main}; rerun npm run build:smoke for diagnostics.`);
  process.exit(1);
}

const electronBin = resolveElectronBinary(root);
const smokeUserData = mkdtempSync(path.join(tmpdir(), "pi-desktop-smoke-"));
let smokeUserDataRemoved = false;

function removeSmokeUserData() {
  if (smokeUserDataRemoved) return;
  smokeUserDataRemoved = true;
  rmSync(smokeUserData, { recursive: true, force: true });
}

const child = spawn(electronBin, [main], {
  cwd: root,
  env: {
    ...process.env,
    ELECTRON_DISABLE_SECURITY_WARNINGS: "1",
    PI_DESKTOP_SMOKE_USER_DATA: smokeUserData,
  },
  stdio: "inherit",
  detached: process.platform !== "win32",
});

const timer = setTimeout(() => {
  console.error("smoke timeout");
  terminateProcessTree(child);
  removeSmokeUserData();
  process.exit(1);
}, 45_000);

child.on("error", (error) => {
  clearTimeout(timer);
  removeSmokeUserData();
  console.error(`smoke Electron failed to start: ${error.message}`);
  process.exit(1);
});

child.on("exit", (code, signal) => {
  clearTimeout(timer);
  removeSmokeUserData();
  if (signal) console.error(`smoke Electron terminated by signal ${signal}`);
  process.exit(code ?? 1);
});
