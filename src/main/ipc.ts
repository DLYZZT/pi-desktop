import { app, BrowserWindow, dialog, ipcMain, nativeTheme, Notification, shell } from "electron";
import type { IpcMainInvokeEvent } from "electron";
import type {
  ChannelCredentialWrite,
  DesktopUpdateState,
  SaveBinaryFileOptions,
  SaveTextFileOptions,
} from "../contract/desktop";
import { exportDiagnostics } from "./diagnostics";
import type { HostManager } from "./host-manager";
import { appendMainLog, getMainLogPath } from "./logger";
import { createHtmlPreviewUrl, releaseHtmlPreviewUrl } from "./protocol";
import { loadUiState, saveUiState } from "./window-state";
import path from "node:path";
import {
  isToolchainActionRequest,
  type PublicToolchainState,
  type ToolchainActionRequest,
} from "../shared/toolchains/types";
import { ToolchainError } from "../shared/toolchains/errors";

export type DesktopIpcOptions = {
  getHostManager: () => HostManager | null;
  getMainWindow: () => BrowserWindow | null;
  getUnreadBadge: () => number;
  applyBadgeCount: (count: number) => void;
  getToolchainState: (cwd?: string) => PublicToolchainState | Promise<PublicToolchainState>;
  rescanToolchains: (cwd?: string) => Promise<PublicToolchainState>;
  performToolchainAction: (request: ToolchainActionRequest) => Promise<PublicToolchainState>;
  chooseCustomTool: (
    capability: Extract<ToolchainActionRequest, { action: "choose-custom-tool" }>["capability"],
    executable: string,
  ) => Promise<PublicToolchainState>;
  setChannelCredential: (payload: ChannelCredentialWrite) => void;
  updateManager: {
    getState: () => DesktopUpdateState;
    checkForUpdates: () => Promise<DesktopUpdateState>;
    downloadUpdate: () => Promise<DesktopUpdateState>;
    installUpdate: () => Promise<void>;
    setAutomaticChecksEnabled: (enabled: boolean) => DesktopUpdateState;
  };
};

export function installDesktopIpc(options: DesktopIpcOptions): void {
  const {
    getHostManager,
    getMainWindow,
    getUnreadBadge,
    applyBadgeCount,
    getToolchainState,
    rescanToolchains,
    performToolchainAction,
    chooseCustomTool,
    setChannelCredential,
    updateManager,
  } = options;
  const assertTrustedToolchainSender = (event: IpcMainInvokeEvent): void => {
    const win = getMainWindow();
    if (
      !win ||
      win.isDestroyed() ||
      event.sender !== win.webContents ||
      event.senderFrame !== win.webContents.mainFrame
    ) {
      throw new Error("Untrusted toolchain IPC sender");
    }
  };

  ipcMain.handle("desktop:get-version", () => app.getVersion());
  ipcMain.handle("desktop:update:get-state", () => updateManager.getState());
  ipcMain.handle("desktop:update:check", () => updateManager.checkForUpdates());
  ipcMain.handle("desktop:update:download", () => updateManager.downloadUpdate());
  ipcMain.handle("desktop:update:install", () => updateManager.installUpdate());
  ipcMain.handle("desktop:update:set-automatic-checks", (_event, enabled: unknown) => {
    if (typeof enabled !== "boolean") throw new Error("Automatic update checks must be a boolean");
    saveUiState({ automaticUpdateChecks: enabled });
    return updateManager.setAutomaticChecksEnabled(enabled);
  });
  ipcMain.handle("desktop:get-host-status", () => getHostManager()?.getStatus() ?? "stopped");
  ipcMain.handle("desktop:toolchains:get-state", (event, cwd: unknown) => {
    assertTrustedToolchainSender(event);
    return getToolchainState(validateOptionalToolchainCwd(cwd));
  });
  ipcMain.handle("desktop:toolchains:rescan", (event, cwd: unknown) => {
    assertTrustedToolchainSender(event);
    const validatedCwd = validateOptionalToolchainCwd(cwd);
    return rescanToolchains(validatedCwd);
  });
  ipcMain.handle("desktop:toolchains:action", async (event, request: unknown) => {
    assertTrustedToolchainSender(event);
    if (!isToolchainActionRequest(request)) throw new Error("Invalid toolchain action request");
    if (request.action === "choose-custom-tool") {
      const win = BrowserWindow.fromWebContents(event.sender);
      const result = await dialog.showOpenDialog(win ?? undefined!, {
        title: `Choose executable for ${request.capability}`,
        properties: ["openFile", "dontAddToRecent"],
      });
      if (result.canceled || !result.filePaths[0]) {
        throw new Error("TOOLCHAIN_CANCELLED: Custom tool selection was cancelled");
      }
      return chooseCustomTool(request.capability, result.filePaths[0]);
    }
    const confirmation = toolchainActionConfirmation(request);
    if (confirmation) {
      const win = BrowserWindow.fromWebContents(event.sender);
      const result = await dialog.showMessageBox(win ?? undefined!, confirmation);
      if (result.response !== 1) throw new Error("TOOLCHAIN_CANCELLED: Toolchain action was cancelled");
    }
    try {
      return await performToolchainAction(request);
    } catch (error) {
      if (error instanceof ToolchainError) {
        appendMainLog(
          `toolchain action=${request.action} failed code=${error.code}${error.causeCode ? ` cause=${error.causeCode}` : ""}`,
        );
        throw new Error(`${error.code}: ${error.message}`);
      }
      appendMainLog(`toolchain action=${request.action} failed code=TOOLCHAIN_INTERNAL`);
      throw new Error("TOOLCHAIN_INTERNAL: Developer tool operation failed");
    }
  });

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

  ipcMain.handle("desktop:set-channel-credential", (_event, payload: ChannelCredentialWrite) => {
    if (!payload || typeof payload !== "object") throw new Error("Invalid channel credential payload");
    if (!payload.credential?.token?.trim() || !payload.credential.baseUrl?.trim()) {
      throw new Error("Channel credential is incomplete");
    }
    setChannelCredential(payload);
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
    return exportDiagnostics(win, { toolchainState: await getToolchainState() });
  });
  ipcMain.handle("desktop:clear-badge", () => applyBadgeCount(0));
}

function toolchainActionConfirmation(request: ToolchainActionRequest): Electron.MessageBoxOptions | undefined {
  const chinese = app.getLocale().toLowerCase().startsWith("zh");
  if (
    request.action === "install-profile" ||
    request.action === "install-component" ||
    request.action === "repair-component"
  ) {
    return {
      type: "warning",
      title: chinese ? "安装开发工具" : "Install developer tools",
      message: chinese
        ? "Pi Desktop 将从界面所示的官方来源下载固定版本。来源会收到你的 IP 地址、平台和架构；文件仅保存在应用私有数据中，也不会修改系统 PATH。是否继续？"
        : "Pi Desktop will download fixed releases from the official sources shown in Developer Tools. The sources receive your IP address, platform, and architecture. Files stay in private app data and system PATH is not changed.",
      buttons: chinese ? ["取消", "继续"] : ["Cancel", "Continue"],
      defaultId: 1,
      cancelId: 0,
      noLink: true,
    };
  }
  if (request.action === "remove-component") {
    return {
      type: "warning",
      title: chinese ? "移除托管工具" : "Remove managed tool",
      message: chinese
        ? "移除此 Pi Desktop 托管运行时？系统工具和自定义工具不会受影响。"
        : "Remove this Pi Desktop-managed runtime? System and custom tools are not affected.",
      buttons: chinese ? ["取消", "移除"] : ["Cancel", "Remove"],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
    };
  }
  if (request.action === "clear-cache") {
    return {
      type: "question",
      title: chinese ? "清理工具缓存" : "Clear tool cache",
      message: chinese
        ? "清除此应用私有缓存？已安装的运行时不会被移除。"
        : "Clear this private app cache? Installed runtimes are not removed.",
      buttons: chinese ? ["取消", "清理"] : ["Cancel", "Clear"],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
    };
  }
  return undefined;
}

function validateOptionalToolchainCwd(value: unknown): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string" || value.length > 4_096 || /[\0\r\n]/.test(value) || !path.isAbsolute(value)) {
    throw new Error("Invalid toolchain workspace path");
  }
  return path.normalize(value);
}
