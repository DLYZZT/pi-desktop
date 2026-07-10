import { app } from "electron";
import fs from "fs";
import path from "path";

let logPath: string | null = null;

function ensureLogPath(): string {
  if (logPath) return logPath;
  const dir = app.getPath("logs");
  fs.mkdirSync(dir, { recursive: true });
  logPath = path.join(dir, "main.log");
  return logPath;
}

export function appendMainLog(line: string): void {
  const stamp = new Date().toISOString();
  const text = `[${stamp}] ${line}\n`;
  try {
    fs.appendFileSync(ensureLogPath(), text);
  } catch {
    // ignore disk errors
  }
  if (!app.isPackaged) {
    console.log(`[main] ${line}`);
  }
}

export function getMainLogPath(): string {
  return ensureLogPath();
}
