import { app, BrowserWindow, dialog, ipcMain, nativeTheme, Notification, shell } from "electron";
import type { IpcMainEvent, IpcMainInvokeEvent } from "electron";
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
import type { BrowserService } from "./browser/browser-service";
import { BrowserError } from "./browser/browser-error";
import { isTrustedDesktopIpcSender } from "./ipc-trust";
import type {
  BrowserConfirmationKind,
  BrowserConfirmationProof,
  BrowserCreateProfileInput,
  BrowserCreateTabInput,
  BrowserDataType,
  BrowserHeaderRule,
  BrowserHeaderRuleDirection,
  BrowserAgentAuthorizationDecision,
  BrowserPersistentSessionPermission,
  BrowserPermissionDecision,
  BrowserProxyCredentialsInput,
  BrowserSettingsPatch,
} from "../contract/browser";

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
  getBrowserService: () => BrowserService | null;
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
    getBrowserService,
    updateManager,
  } = options;
  const assertTrustedSender = (event: IpcMainInvokeEvent): void => {
    const win = getMainWindow();
    if (!isTrustedDesktopIpcSender(win, event)) throw new Error("Untrusted desktop IPC sender");
  };
  const trustedHandle = <T extends unknown[], R>(
    channel: string,
    handler: (event: IpcMainInvokeEvent, ...args: T) => R | Promise<R>,
  ): void => {
    ipcMain.handle(channel, (event, ...args) => {
      assertTrustedSender(event);
      return handler(event, ...(args as T));
    });
  };
  const trustedOn = <T extends unknown[]>(
    channel: string,
    listener: (event: IpcMainEvent, ...args: T) => void,
  ): void => {
    ipcMain.on(channel, (event, ...args) => {
      if (!isTrustedDesktopIpcSender(getMainWindow(), event)) return;
      listener(event, ...(args as T));
    });
  };
  const requireTrustedBrowser = (event: IpcMainInvokeEvent): BrowserService => {
    assertTrustedSender(event);
    const browser = getBrowserService();
    if (!browser) throw new Error("BROWSER_DISABLED: Browser service is unavailable");
    return browser;
  };
  const browserHandler = <T extends unknown[], R>(
    channel: string,
    handler: (browser: BrowserService, ...args: T) => R | Promise<R>,
  ): void => {
    trustedHandle(channel, async (event, ...args: T) => {
      const browser = requireTrustedBrowser(event);
      try {
        return await handler(browser, ...args);
      } catch (error) {
        if (error instanceof BrowserError) throw new Error(`${error.code}: ${error.message}`);
        throw error;
      }
    });
  };

  trustedHandle("desktop:get-version", () => app.getVersion());
  trustedHandle("desktop:update:get-state", () => updateManager.getState());
  trustedHandle("desktop:update:check", () => updateManager.checkForUpdates());
  trustedHandle("desktop:update:download", () => updateManager.downloadUpdate());
  trustedHandle("desktop:update:install", () => updateManager.installUpdate());
  trustedHandle("desktop:update:set-automatic-checks", (_event, enabled: unknown) => {
    if (typeof enabled !== "boolean") throw new Error("Automatic update checks must be a boolean");
    saveUiState({ automaticUpdateChecks: enabled });
    return updateManager.setAutomaticChecksEnabled(enabled);
  });
  trustedHandle("desktop:get-host-status", () => getHostManager()?.getStatus() ?? "stopped");
  trustedHandle("desktop:toolchains:get-state", (_event, cwd: unknown) => {
    return getToolchainState(validateOptionalToolchainCwd(cwd));
  });
  trustedHandle("desktop:toolchains:rescan", (_event, cwd: unknown) => {
    const validatedCwd = validateOptionalToolchainCwd(cwd);
    return rescanToolchains(validatedCwd);
  });
  trustedHandle("desktop:toolchains:action", async (event, request: unknown) => {
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

  trustedOn("desktop:connect-host", (event) => {
    const manager = getHostManager();
    if (!manager) return;
    const { port1 } = manager.createRendererChannel();
    event.sender.postMessage("desktop:host-port", null, [port1]);
  });

  trustedHandle("desktop:open-external", async (_event, url: string) => {
    if (typeof url !== "string") return;
    if (!/^(https?:|mailto:)/i.test(url)) throw new Error("Blocked non-http(s)/mailto URL");
    await shell.openExternal(url);
  });

  trustedHandle("desktop:show-item-in-folder", async (_event, fsPath: string) => {
    if (typeof fsPath === "string") shell.showItemInFolder(fsPath);
  });

  trustedHandle("desktop:select-directory", async (event) => {
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

  trustedHandle("desktop:set-channel-credential", (_event, payload: ChannelCredentialWrite) => {
    if (!payload || typeof payload !== "object") throw new Error("Invalid channel credential payload");
    if (!payload.credential?.token?.trim() || !payload.credential.baseUrl?.trim()) {
      throw new Error("Channel credential is incomplete");
    }
    setChannelCredential(payload);
  });

  trustedHandle("desktop:save-file", async (event, saveOptions: SaveTextFileOptions) => {
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

  trustedHandle("desktop:save-binary-file", async (event, saveOptions: SaveBinaryFileOptions) => {
    if (!saveOptions || typeof saveOptions.base64 !== "string") throw new Error("Invalid binary save payload");
    const win = BrowserWindow.fromWebContents(event.sender);
    const result = await dialog.showSaveDialog(win ?? undefined!, { defaultPath: saveOptions.defaultPath });
    if (result.canceled || !result.filePath) return null;
    const fs = await import("fs");
    fs.writeFileSync(result.filePath, Buffer.from(saveOptions.base64, "base64"));
    return result.filePath;
  });

  trustedHandle(
    "desktop:create-html-preview",
    (event, content: string, filePath: string, sourceSessionId?: string | null) =>
      createHtmlPreviewUrl(
        content,
        filePath,
        async (assetPath) => {
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
        },
        event.sender.id,
      ),
  );
  trustedHandle("desktop:release-html-preview", (_event, previewUrl: string) => {
    releaseHtmlPreviewUrl(previewUrl);
  });

  trustedOn("desktop:notify-agent-end", (_event, payload: { sessionId: string; title?: string }) => {
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

  trustedOn("desktop:set-badge-count", (_event, count: number) => applyBadgeCount(count));
  trustedHandle("desktop:get-ui-state", () => loadUiState());
  trustedHandle("desktop:set-ui-state", (_event, patch: Record<string, unknown>) => saveUiState(patch));
  trustedHandle("desktop:get-theme-source", () => nativeTheme.themeSource);
  trustedHandle("desktop:set-theme-source", (_event, source: "system" | "light" | "dark") => {
    nativeTheme.themeSource = source;
    saveUiState({ theme: source });
  });
  trustedHandle("desktop:open-logs", () => shell.showItemInFolder(getMainLogPath()));
  trustedHandle("desktop:export-diagnostics", async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    return exportDiagnostics(win, {
      toolchainState: await getToolchainState(),
      browser: getBrowserService()?.getRedactedDiagnostics(),
    });
  });
  browserHandler("desktop:browser:get-state", (browser) => browser.getState());
  browserHandler("desktop:browser:get-settings", (browser) => browser.getSettings());
  browserHandler(
    "desktop:browser:request-confirmation",
    (browser, kind: BrowserConfirmationKind, payload?: BrowserSettingsPatch, language?: "en-US" | "zh-CN") =>
      browser.requestConfirmation(kind, payload, language),
  );
  browserHandler(
    "desktop:browser:update-settings",
    (browser, patch: BrowserSettingsPatch, proof?: BrowserConfirmationProof) => browser.updateSettings(patch, proof),
  );
  browserHandler("desktop:browser:list-tabs", (browser, sessionId?: string) => browser.listTabs(sessionId));
  browserHandler("desktop:browser:create-user-tab", (browser, input: BrowserCreateTabInput) =>
    browser.createUserTab(input),
  );
  browserHandler("desktop:browser:activate-tab", (browser, tabId: string) => browser.activateTab(tabId));
  browserHandler("desktop:browser:navigate-user", (browser, tabId: string, url: string) =>
    browser.navigateUser(tabId, url),
  );
  browserHandler("desktop:browser:go-back", (browser, tabId: string) => browser.goBack(tabId));
  browserHandler("desktop:browser:go-forward", (browser, tabId: string) => browser.goForward(tabId));
  browserHandler("desktop:browser:reload", (browser, tabId: string) => browser.reload(tabId));
  browserHandler("desktop:browser:stop", (browser, tabId: string) => browser.stop(tabId));
  browserHandler("desktop:browser:close-tab", (browser, tabId: string) => browser.closeTab(tabId));
  browserHandler("desktop:browser:close-all-tabs", (browser) => browser.closeAllTabs());
  browserHandler("desktop:browser:set-bounds", (browser, input: Parameters<BrowserService["setBounds"]>[0]) =>
    browser.setBounds(input),
  );
  browserHandler("desktop:browser:set-surface-visible", (browser, input: { tabId?: string; visible: boolean }) =>
    browser.setSurfaceVisible(input),
  );
  browserHandler(
    "desktop:browser:set-persistent-session-permission",
    (browser, sessionId: string, permission: BrowserPersistentSessionPermission) =>
      browser.setPersistentSessionPermission(sessionId, permission),
  );
  browserHandler("desktop:browser:revoke-temporary-session-permission", (browser, sessionId: string) =>
    browser.revokeTemporarySessionPermission(sessionId),
  );
  browserHandler(
    "desktop:browser:respond-agent-authorization",
    (browser, requestId: string, decision: BrowserAgentAuthorizationDecision) =>
      browser.respondAgentAuthorization(requestId, decision),
  );
  browserHandler("desktop:browser:list-profiles", (browser) => browser.listProfiles());
  browserHandler("desktop:browser:create-profile", (browser, input: BrowserCreateProfileInput) =>
    browser.createProfile(input),
  );
  browserHandler("desktop:browser:rename-profile", (browser, profileId: string, name: string) =>
    browser.renameProfile(profileId, name),
  );
  browserHandler("desktop:browser:delete-profile", (browser, profileId: string) => browser.deleteProfile(profileId));
  browserHandler("desktop:browser:clear-profile-data", (browser, profileId: string, dataType: BrowserDataType) =>
    browser.clearProfileData(profileId, dataType),
  );
  browserHandler("desktop:browser:set-proxy-credentials", (browser, credentials: BrowserProxyCredentialsInput | null) =>
    browser.setProxyCredentials(credentials),
  );
  browserHandler(
    "desktop:browser:get-header-rules",
    (browser, profileId: string, direction: BrowserHeaderRuleDirection) => browser.getHeaderRules(profileId, direction),
  );
  browserHandler(
    "desktop:browser:set-header-rules",
    (browser, profileId: string, direction: BrowserHeaderRuleDirection, rules: BrowserHeaderRule[]) =>
      browser.setLocalHeaderRules(profileId, direction, rules),
  );
  browserHandler("desktop:browser:store-header-secret", (browser, value: string, existingRef?: string) =>
    browser.storeHeaderSecret(value, existingRef),
  );
  browserHandler("desktop:browser:remove-header-secret", (browser, secretRef: string) =>
    browser.removeHeaderSecret(secretRef),
  );
  browserHandler("desktop:browser:list-page-snippets", (browser) => browser.listPageSnippets());
  browserHandler("desktop:browser:set-page-snippet-enabled", (browser, snippetId: string, enabled: boolean) =>
    browser.setPageSnippetEnabled(snippetId, enabled),
  );
  browserHandler("desktop:browser:delete-page-snippet", (browser, snippetId: string) =>
    browser.deletePageSnippet(snippetId),
  );
  browserHandler("desktop:browser:clear-page-snippets", (browser) => browser.clearPageSnippets());
  browserHandler(
    "desktop:browser:respond-permission",
    (browser, requestId: string, decision: BrowserPermissionDecision) => browser.respondPermission(requestId, decision),
  );
  browserHandler("desktop:browser:choose-upload-files", (browser, tabId: string) => browser.chooseUploadFiles(tabId));
  browserHandler("desktop:browser:reset", (browser) => browser.reset());
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
