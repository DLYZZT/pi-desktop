/**
 * Export a diagnostic zip-like folder: logs + version + system info.
 */
import { app, dialog, shell, type BrowserWindow } from "electron";
import fs from "fs";
import path from "path";
import os from "os";
import { getMainLogPath } from "./logger";

export async function exportDiagnostics(win: BrowserWindow | null): Promise<string | null> {
  const defaultName = `pi-desktop-diag-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  const result = await dialog.showSaveDialog(win ?? undefined!, {
    defaultPath: path.join(app.getPath("desktop"), defaultName),
    title: "Export diagnostics",
    properties: ["createDirectory", "showOverwriteConfirmation"],
  });
  if (result.canceled || !result.filePath) return null;

  const outDir = result.filePath;
  fs.mkdirSync(outDir, { recursive: true });

  const info = {
    appVersion: app.getVersion(),
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
    platform: process.platform,
    arch: process.arch,
    os: `${os.type()} ${os.release()}`,
    homedir: os.homedir(),
    userData: app.getPath("userData"),
    logs: app.getPath("logs"),
    exportedAt: new Date().toISOString(),
  };
  fs.writeFileSync(path.join(outDir, "system.json"), JSON.stringify(info, null, 2));

  // Copy main log if present
  try {
    const mainLog = getMainLogPath();
    if (fs.existsSync(mainLog)) {
      fs.copyFileSync(mainLog, path.join(outDir, "main.log"));
    }
  } catch {
    /* ignore */
  }

  // Copy other logs in log dir
  try {
    const logDir = app.getPath("logs");
    for (const name of fs.readdirSync(logDir)) {
      if (!name.endsWith(".log")) continue;
      const src = path.join(logDir, name);
      const dest = path.join(outDir, name);
      if (!fs.existsSync(dest)) fs.copyFileSync(src, dest);
    }
  } catch {
    /* ignore */
  }

  shell.showItemInFolder(outDir);
  return outDir;
}
