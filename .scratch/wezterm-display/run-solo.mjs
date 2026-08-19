import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const wezterm = process.env.WEZTERM_GUI || "C:\\Program Files\\WezTerm\\wezterm-gui.exe";
const nodeExe = process.env.NODE_BINARY || "C:\\Program Files\\nodejs\\node.exe";
const piCli = path.join(root, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "cli.js");
const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "wezterm-solo-spike-"));

console.log(`[solo] cwd=${cwd}`);
const child = spawn(
  wezterm,
  [
    "--skip-config",
    "start",
    "--always-new-process",
    "--class",
    "org.pi.wezterm.spike.solo",
    "--cwd",
    cwd,
    "--",
    nodeExe,
    piCli,
    "--session-id",
    "spike-wezterm-solo",
    "--tui-mode",
    "fullscreen",
  ],
  { stdio: "inherit", windowsHide: false },
);
child.on("exit", (code) => process.exit(code ?? 0));
