import { app, BrowserWindow, dialog, ipcMain, nativeTheme, Notification, shell } from "electron";
import type { SaveBinaryFileOptions, SaveTextFileOptions } from "../contract/desktop";
import { exportDiagnostics } from "./diagnostics";
import type { HostManager } from "./host-manager";
import { getMainLogPath } from "./logger";
import { createHtmlPreviewUrl, releaseHtmlPreviewUrl } from "./protocol";
import { loadUiState, saveUiState } from "./window-state";

export type DesktopIpcOptions = {
  getHostManager: () => HostManager | null;
  getMainWindow: () => BrowserWindow | null;
  getUnreadBadge: () => number;
  applyBadgeCount: (count: number) => void;
};

export function installDesktopIpc(options: DesktopIpcOptions): void {
  const { getHostManager, getMainWindow, getUnreadBadge, applyBadgeCount } = options;

  ipcMain.handle("desktop:get-version", () => app.getVersion());
  ipcMain.handle("desktop:get-host-status", () => getHostManager()?.getStatus() ?? "stopped");

  ipcMain.on("desktop:connect-host", (event) => {
    const manager = getHostManager();
    if (!manager) return;
    const { port1 } = manager.createRendererChannel();
    event.sender.postMessage("desktop:host-port", null, [port1]);
  });

  ipcMain.handle("desktop:open-external", async (_event, url: string) => {
    if (typeof url !== "string") return;
    if (!/^(https?:|mailto:)/i.test(url)) throw new Error("Blocked non-http(s)/mailto URL");
    await shell.openExternal(url);
  });

  ipcMain.handle("desktop:show-item-in-folder", async (_event, fsPath: string) => {
    if (typeof fsPath === "string") shell.showItemInFolder(fsPath);
  });

  ipcMain.handle("desktop:select-directory", async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    const ui = loadUiState();
    const result = await dialog.showOpenDialog(win ?? undefined!, {
      properties: ["openDirectory", "createDirectory"],
      defaultPath: ui.recentCwds?.[0],
    });
    if (result.canceled || !result.filePaths[0]) return null;
    const directory = result.filePaths[0];
    const recent = [directory, ...(ui.recentCwds ?? []).filter((entry) => entry !== directory)].slice(0, 12);
    saveUiState({ recentCwds: recent });
    return directory;
  });

  ipcMain.handle("desktop:save-file", async (event, saveOptions: SaveTextFileOptions) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    const result = await dialog.showSaveDialog(win ?? undefined!, {
      defaultPath: saveOptions.defaultPath,
      filters: saveOptions.filters ?? [{ name: "Markdown", extensions: ["md"] }],
    });
    if (result.canceled || !result.filePath) return null;
    const fs = await import("fs");
    fs.writeFileSync(result.filePath, saveOptions.content, "utf8");
    return result.filePath;
  });

  ipcMain.handle("desktop:save-binary-file", async (event, saveOptions: SaveBinaryFileOptions) => {
    if (!saveOptions || typeof saveOptions.base64 !== "string") throw new Error("Invalid binary save payload");
    const win = BrowserWindow.fromWebContents(event.sender);
    const result = await dialog.showSaveDialog(win ?? undefined!, { defaultPath: saveOptions.defaultPath });
    if (result.canceled || !result.filePath) return null;
    const fs = await import("fs");
    fs.writeFileSync(result.filePath, Buffer.from(saveOptions.base64, "base64"));
    return result.filePath;
  });

  ipcMain.handle(
    "desktop:create-html-preview",
    (_event, content: string, filePath: string, sourceSessionId?: string | null) =>
      createHtmlPreviewUrl(content, filePath, async (assetPath) => {
        const manager = getHostManager();
        if (!manager) throw new Error("Agent Host is unavailable");
        const meta = await manager.call<{ size: number }>("files.meta", {
          path: assetPath,
          sourceSessionId: sourceSessionId ?? undefined,
        });
        if (meta.size > 20 * 1024 * 1024) throw new Error("HTML preview asset is too large");
        return manager.call<{ base64: string; size: number; mime?: string }>("files.download", {
          path: assetPath,
          sourceSessionId: sourceSessionId ?? undefined,
        });
      }),
  );
  ipcMain.handle("desktop:release-html-preview", (_event, previewUrl: string) => {
    releaseHtmlPreviewUrl(previewUrl);
  });

  ipcMain.on("desktop:notify-agent-end", (_event, payload: { sessionId: string; title?: string }) => {
    if (!Notification.isSupported()) return;
    const notification = new Notification({
      title: payload.title || "Agent finished",
      body: "Session completed",
    });
    notification.on("click", () => {
      const win = getMainWindow();
      if (win) {
        win.show();
        win.focus();
        win.webContents.send("deep-link:session", payload.sessionId);
      }
    });
    notification.show();
    applyBadgeCount(getUnreadBadge() + 1);
  });

  ipcMain.on("desktop:set-badge-count", (_event, count: number) => applyBadgeCount(count));
  ipcMain.handle("desktop:get-ui-state", () => loadUiState());
  ipcMain.handle("desktop:set-ui-state", (_event, patch: Record<string, unknown>) => saveUiState(patch));
  ipcMain.handle("desktop:get-theme-source", () => nativeTheme.themeSource);
  ipcMain.handle("desktop:set-theme-source", (_event, source: "system" | "light" | "dark") => {
    nativeTheme.themeSource = source;
    saveUiState({ theme: source });
  });
  ipcMain.handle("desktop:open-logs", () => shell.showItemInFolder(getMainLogPath()));
  ipcMain.handle("desktop:export-diagnostics", async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    return exportDiagnostics(win);
  });
  ipcMain.handle("desktop:clear-badge", () => applyBadgeCount(0));
}
