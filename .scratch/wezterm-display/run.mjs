import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const electron = path.join(root, "node_modules", ".bin", process.platform === "win32" ? "electron.cmd" : "electron");
const main = path.join(root, ".scratch", "wezterm-display", "spike-main.cjs");
const child = spawn(electron, [main], { stdio: "inherit", cwd: root, shell: process.platform === "win32" });
child.on("exit", (code) => process.exit(code ?? 0));
