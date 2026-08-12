/**
 * Preload — expose piBridge only (sandbox + contextIsolation).
 *
 * MessagePort MUST NOT cross contextBridge via Promise resolve — that silently
 * breaks the port. Use window.postMessage transfer instead (Electron docs).
 */
import { contextBridge, ipcRenderer } from "electron";
import type { DesktopMenuEvent, DesktopUpdateState, HostStatus, PiBridge } from "../contract/desktop";
import type { BrowserEvent } from "../contract/browser";
import { EarlyEventReplay } from "./early-event-replay";
import { isTrustedPreloadLocation } from "./preload-location-policy";
import { isValidDeepLinkSessionMessage, selectTransferredHostPort } from "./preload-message-policy";

const preloadLocation = (globalThis as unknown as { location?: { href?: unknown } }).location?.href;

if (typeof preloadLocation === "string" && isTrustedPreloadLocation(preloadLocation)) {
  // Deliver MessagePort to the page via window.postMessage (transferable).
  ipcRenderer.on("desktop:host-port", (event) => {
    const port = selectTransferredHostPort(event.ports);
    if (!port) return;
    // preload: MessagePort transfer to the page
    const g = globalThis as unknown as {
      postMessage: (message: unknown, targetOrigin: string, transfer?: unknown[]) => void;
    };
    g.postMessage({ channel: "pi-desktop-host-port" }, "*", [port]);
  });

  // Buffer one bounded generation per fixed event until Renderer listeners subscribe.
  const deepLinkEvents = new EarlyEventReplay<string>();
  const menuEvents = [
    "new-session",
    "settings",
    "check-for-updates",
    "show-update",
    "switch-session",
    "export-diagnostics",
  ] as const satisfies readonly DesktopMenuEvent[];
  const menuEventSet = new Set<string>(menuEvents);
  const menuEventReplays = new Map(menuEvents.map((event) => [event, new EarlyEventReplay<void>()]));

  ipcRenderer.on("deep-link:session", (_e, sessionId: unknown) => {
    if (!isValidDeepLinkSessionMessage(sessionId)) return;
    deepLinkEvents.emit(sessionId);
  });

  // Main can send a menu command as soon as a newly created page finishes
  // loading, before React effects subscribe. Buffer one pending command per
  // fixed event so notification/menu navigation is not lost during startup.
  for (const event of menuEvents) {
    ipcRenderer.on(`menu:${event}`, () => {
      menuEventReplays.get(event)?.emit(undefined);
    });
  }

  const bridge: PiBridge = {
    platform: process.platform,
    isDesktop: true,
    getVersion: () => ipcRenderer.invoke("desktop:get-version"),
    getUpdateState: () => ipcRenderer.invoke("desktop:update:get-state"),
    checkForUpdates: () => ipcRenderer.invoke("desktop:update:check"),
    downloadUpdate: () => ipcRenderer.invoke("desktop:update:download"),
    installUpdate: () => ipcRenderer.invoke("desktop:update:install"),
    setAutomaticUpdateChecks: (enabled) => ipcRenderer.invoke("desktop:update:set-automatic-checks", enabled),
    getHostStatus: () => ipcRenderer.invoke("desktop:get-host-status"),
    getToolchainState: (cwd) => ipcRenderer.invoke("desktop:toolchains:get-state", cwd),
    rescanToolchains: (cwd) => ipcRenderer.invoke("desktop:toolchains:rescan", cwd),
    performToolchainAction: (request) => ipcRenderer.invoke("desktop:toolchains:action", request),
    requestHostPort: () => {
      ipcRenderer.send("desktop:connect-host");
    },
    openExternal: (url) => ipcRenderer.invoke("desktop:open-external", url),
    showItemInFolder: (fsPath) => ipcRenderer.invoke("desktop:show-item-in-folder", fsPath),
    selectDirectory: () => ipcRenderer.invoke("desktop:select-directory"),
    setChannelCredential: (payload) => ipcRenderer.invoke("desktop:set-channel-credential", payload),
    saveFile: (opts) => ipcRenderer.invoke("desktop:save-file", opts),
    saveBinaryFile: (opts) => ipcRenderer.invoke("desktop:save-binary-file", opts),
    createHtmlPreview: (content, filePath, sourceSessionId) =>
      ipcRenderer.invoke("desktop:create-html-preview", content, filePath, sourceSessionId),
    releaseHtmlPreview: (previewUrl) => ipcRenderer.invoke("desktop:release-html-preview", previewUrl),
    notifyAgentEnd: (payload) => {
      ipcRenderer.send("desktop:notify-agent-end", payload);
    },
    setBadgeCount: (n) => {
      ipcRenderer.send("desktop:set-badge-count", n);
    },
    getUiState: () => ipcRenderer.invoke("desktop:get-ui-state"),
    setUiState: (patch) => ipcRenderer.invoke("desktop:set-ui-state", patch),
    getThemeSource: () => ipcRenderer.invoke("desktop:get-theme-source"),
    setThemeSource: (source) => ipcRenderer.invoke("desktop:set-theme-source", source),
    openLogs: () => ipcRenderer.invoke("desktop:open-logs"),
    exportDiagnostics: () => ipcRenderer.invoke("desktop:export-diagnostics"),
    browserGetState: () => ipcRenderer.invoke("desktop:browser:get-state"),
    browserGetSettings: () => ipcRenderer.invoke("desktop:browser:get-settings"),
    browserRequestConfirmation: (kind, payload, language) =>
      ipcRenderer.invoke("desktop:browser:request-confirmation", kind, payload, language),
    browserUpdateSettings: (patch, confirmation) =>
      ipcRenderer.invoke("desktop:browser:update-settings", patch, confirmation),
    browserListTabs: (sessionId) => ipcRenderer.invoke("desktop:browser:list-tabs", sessionId),
    browserCreateUserTab: (input) => ipcRenderer.invoke("desktop:browser:create-user-tab", input),
    browserActivateTab: (tabId) => ipcRenderer.invoke("desktop:browser:activate-tab", tabId),
    browserNavigateUser: (tabId, url) => ipcRenderer.invoke("desktop:browser:navigate-user", tabId, url),
    browserGoBack: (tabId) => ipcRenderer.invoke("desktop:browser:go-back", tabId),
    browserGoForward: (tabId) => ipcRenderer.invoke("desktop:browser:go-forward", tabId),
    browserReload: (tabId) => ipcRenderer.invoke("desktop:browser:reload", tabId),
    browserStop: (tabId) => ipcRenderer.invoke("desktop:browser:stop", tabId),
    browserCloseTab: (tabId) => ipcRenderer.invoke("desktop:browser:close-tab", tabId),
    browserCloseAllTabs: () => ipcRenderer.invoke("desktop:browser:close-all-tabs"),
    browserSetBounds: (input) => ipcRenderer.invoke("desktop:browser:set-bounds", input),
    browserSetSurfaceVisible: (input) => ipcRenderer.invoke("desktop:browser:set-surface-visible", input),
    browserSetPersistentSessionPermission: (sessionId, permission) =>
      ipcRenderer.invoke("desktop:browser:set-persistent-session-permission", sessionId, permission),
    browserRevokeTemporarySessionPermission: (sessionId) =>
      ipcRenderer.invoke("desktop:browser:revoke-temporary-session-permission", sessionId),
    browserRespondAgentAuthorization: (requestId, decision) =>
      ipcRenderer.invoke("desktop:browser:respond-agent-authorization", requestId, decision),
    browserListProfiles: () => ipcRenderer.invoke("desktop:browser:list-profiles"),
    browserCreateProfile: (input) => ipcRenderer.invoke("desktop:browser:create-profile", input),
    browserRenameProfile: (profileId, name) => ipcRenderer.invoke("desktop:browser:rename-profile", profileId, name),
    browserDeleteProfile: (profileId) => ipcRenderer.invoke("desktop:browser:delete-profile", profileId),
    browserClearProfileData: (profileId, dataType) =>
      ipcRenderer.invoke("desktop:browser:clear-profile-data", profileId, dataType),
    browserSetProxyCredentials: (credentials) =>
      ipcRenderer.invoke("desktop:browser:set-proxy-credentials", credentials),
    browserGetHeaderRules: (profileId, direction) =>
      ipcRenderer.invoke("desktop:browser:get-header-rules", profileId, direction),
    browserSetHeaderRules: (profileId, direction, rules) =>
      ipcRenderer.invoke("desktop:browser:set-header-rules", profileId, direction, rules),
    browserStoreHeaderSecret: (value, existingRef) =>
      ipcRenderer.invoke("desktop:browser:store-header-secret", value, existingRef),
    browserRemoveHeaderSecret: (secretRef) => ipcRenderer.invoke("desktop:browser:remove-header-secret", secretRef),
    browserListPageSnippets: () => ipcRenderer.invoke("desktop:browser:list-page-snippets"),
    browserSetPageSnippetEnabled: (snippetId, enabled) =>
      ipcRenderer.invoke("desktop:browser:set-page-snippet-enabled", snippetId, enabled),
    browserDeletePageSnippet: (snippetId) => ipcRenderer.invoke("desktop:browser:delete-page-snippet", snippetId),
    browserClearPageSnippets: () => ipcRenderer.invoke("desktop:browser:clear-page-snippets"),
    browserRespondPermission: (requestId, decision) =>
      ipcRenderer.invoke("desktop:browser:respond-permission", requestId, decision),
    browserChooseUploadFiles: (tabId) => ipcRenderer.invoke("desktop:browser:choose-upload-files", tabId),
    browserReset: () => ipcRenderer.invoke("desktop:browser:reset"),
    clearBadge: () => {
      ipcRenderer.send("desktop:set-badge-count", 0);
    },
    onHostStatus: (cb) => {
      const handler = (_: Electron.IpcRendererEvent, data: { status: HostStatus; detail?: string }) => cb(data);
      ipcRenderer.on("host:status", handler);
      return () => ipcRenderer.removeListener("host:status", handler);
    },
    onHostRestarted: (cb) => {
      const handler = (_: Electron.IpcRendererEvent, data: { reason: string }) => cb(data);
      ipcRenderer.on("host:restarted", handler);
      return () => ipcRenderer.removeListener("host:restarted", handler);
    },
    onHostCrashed: (cb) => {
      const handler = (_: Electron.IpcRendererEvent, data: { detail?: string }) => cb(data);
      ipcRenderer.on("host:crashed", handler);
      return () => ipcRenderer.removeListener("host:crashed", handler);
    },
    onUpdateState: (cb) => {
      const handler = (_: Electron.IpcRendererEvent, state: DesktopUpdateState) => cb(state);
      ipcRenderer.on("update:state", handler);
      return () => ipcRenderer.removeListener("update:state", handler);
    },
    onToolchainState: (cb) => {
      const handler = (_: Electron.IpcRendererEvent, state: Parameters<typeof cb>[0]) => cb(state);
      ipcRenderer.on("toolchains:state", handler);
      return () => ipcRenderer.removeListener("toolchains:state", handler);
    },
    onDeepLinkSession: (cb) => {
      return deepLinkEvents.subscribe(cb);
    },
    onBrowserEvent: (cb) => {
      const handler = (_: Electron.IpcRendererEvent, event: BrowserEvent) => cb(event);
      ipcRenderer.on("browser:event", handler);
      return () => ipcRenderer.removeListener("browser:event", handler);
    },
    onMenu: (event, cb) => {
      if (!menuEventSet.has(event)) return () => undefined;
      const fixedEvent = event as DesktopMenuEvent;
      return menuEventReplays.get(fixedEvent)?.subscribe(cb) ?? (() => undefined);
    },
  };

  contextBridge.exposeInMainWorld("piBridge", bridge);
}
