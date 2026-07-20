/** Export an explicitly user-selected, redacted diagnostic folder. */
import { app, dialog, shell, type BrowserWindow } from "electron";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { PublicToolchainState } from "../shared/toolchains/types";
import { getMainLogPath } from "./logger";
import { buildToolchainDiagnosticSummary, redactDiagnosticText } from "./diagnostics-redaction.ts";

const MAX_LOG_BYTES = 5 * 1024 * 1024;
const MAX_CRASH_METADATA_ENTRIES = 256;

export interface ExportDiagnosticsOptions {
  toolchainState?: PublicToolchainState;
}

export async function exportDiagnostics(
  win: BrowserWindow | null,
  options: ExportDiagnosticsOptions = {},
): Promise<string | null> {
  const defaultName = `pi-desktop-diag-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  const result = await dialog.showSaveDialog(win ?? undefined!, {
    defaultPath: path.join(app.getPath("desktop"), defaultName),
    title: "Export diagnostics",
    properties: ["createDirectory", "showOverwriteConfirmation"],
  });
  if (result.canceled || !result.filePath) return null;

  const outDir = result.filePath;
  fs.mkdirSync(outDir, { recursive: true, mode: 0o700 });
  const roots = {
    homeDir: app.getPath("home"),
    userDataDir: app.getPath("userData"),
    logsDir: app.getPath("logs"),
    platform: process.platform,
  } as const;

  const info = {
    appVersion: app.getVersion(),
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
    platform: process.platform,
    arch: process.arch,
    os: `${os.type()} ${os.release()}`,
    homedir: process.platform === "win32" ? "%USERPROFILE%" : "$HOME",
    userData: "<userData>",
    logs: "<logs>",
    exportedAt: new Date().toISOString(),
    privacy:
      "Logs are size-limited and redacted; environment variables, credentials, and raw crash dumps are excluded.",
  };
  writePrivateJson(path.join(outDir, "system.json"), info);
  if (options.toolchainState) {
    writePrivateJson(path.join(outDir, "toolchains.json"), buildToolchainDiagnosticSummary(options.toolchainState));
  }

  const copiedNames = new Set<string>();
  copyRedactedLog(getMainLogPath(), "main.log", outDir, roots, copiedNames);
  try {
    for (const name of fs.readdirSync(roots.logsDir).sort()) {
      if (!name.toLowerCase().endsWith(".log")) continue;
      copyRedactedLog(path.join(roots.logsDir, name), path.basename(name), outDir, roots, copiedNames);
    }
  } catch {
    /* ignore unavailable log directories */
  }

  // Minidumps can contain process memory and credentials. Export metadata only;
  // a user can separately share a raw dump after reviewing that higher-risk file.
  const crashMetadata = collectCrashMetadata(app.getPath("crashDumps"));
  if (crashMetadata.length > 0) writePrivateJson(path.join(outDir, "crash-dumps.json"), crashMetadata);

  shell.showItemInFolder(outDir);
  return outDir;
}

function copyRedactedLog(
  source: string,
  destinationName: string,
  outDir: string,
  roots: Parameters<typeof redactDiagnosticText>[1],
  copiedNames: Set<string>,
): void {
  if (copiedNames.has(destinationName)) return;
  try {
    const stat = fs.lstatSync(source);
    if (!stat.isFile() || stat.isSymbolicLink()) return;
    const content = readBoundedLog(source, stat.size);
    const redacted = redactDiagnosticText(content, roots);
    fs.writeFileSync(path.join(outDir, destinationName), redacted, { encoding: "utf8", mode: 0o600 });
    copiedNames.add(destinationName);
  } catch {
    /* diagnostics are best-effort and must not block export */
  }
}

function readBoundedLog(filePath: string, size: number): string {
  if (size <= MAX_LOG_BYTES) return fs.readFileSync(filePath, "utf8");
  const descriptor = fs.openSync(filePath, "r");
  try {
    const buffer = Buffer.allocUnsafe(MAX_LOG_BYTES);
    fs.readSync(descriptor, buffer, 0, buffer.length, size - buffer.length);
    return `[older log content omitted; original size ${size} bytes]\n${buffer.toString("utf8")}`;
  } finally {
    fs.closeSync(descriptor);
  }
}

function collectCrashMetadata(directory: string): Array<{ name: string; size: number; modifiedAt: string }> {
  try {
    const root = fs.lstatSync(directory);
    if (!root.isDirectory() || root.isSymbolicLink()) return [];
    return fs
      .readdirSync(directory, { withFileTypes: true })
      .filter((entry) => entry.isFile() && !entry.isSymbolicLink())
      .slice(0, MAX_CRASH_METADATA_ENTRIES)
      .flatMap((entry) => {
        try {
          const stat = fs.lstatSync(path.join(directory, entry.name));
          return [{ name: entry.name, size: stat.size, modifiedAt: stat.mtime.toISOString() }];
        } catch {
          return [];
        }
      });
  } catch {
    return [];
  }
}

function writePrivateJson(filePath: string, value: unknown): void {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
}
