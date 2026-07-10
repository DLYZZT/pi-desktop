#!/usr/bin/env node
/**
 * Smoke test: launch electron with PI_SMOKE_TEST=1, host ready + sessions.list, exit.
 * For CI — currently a lightweight host-entry check when electron is available.
 */
import { spawn } from "child_process";
import path from "path";
import { fileURLToPath } from "url";
import { existsSync } from "fs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const main = path.join(root, "out", "main", "main.js");

if (!existsSync(main)) {
  console.error("Build first: npm run build");
  process.exit(1);
}

const electronBin = path.join(
  root,
  "node_modules",
  ".bin",
  process.platform === "win32" ? "electron.cmd" : "electron",
);

const child = spawn(electronBin, ["."], {
  cwd: root,
  env: {
    ...process.env,
    PI_SMOKE_TEST: "1",
    ELECTRON_DISABLE_SECURITY_WARNINGS: "1",
  },
  stdio: "inherit",
});

const timer = setTimeout(() => {
  console.error("smoke timeout");
  child.kill();
  process.exit(1);
}, 45_000);

child.on("exit", (code) => {
  clearTimeout(timer);
  process.exit(code ?? 1);
});
