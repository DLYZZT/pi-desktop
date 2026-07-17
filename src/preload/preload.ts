/**
 * Preload — expose piBridge only (sandbox + contextIsolation).
 *
 * MessagePort MUST NOT cross contextBridge via Promise resolve — that silently
 * breaks the port. Use window.postMessage transfer instead (Electron docs).
 */
import { contextBridge, ipcRenderer } from "electron";
import type { DesktopMenuEvent, DesktopUpdateState, HostStatus, PiBridge } from "../contract/desktop";

// Deliver MessagePort to the page via window.postMessage (transferable).
ipcRenderer.on("desktop:host-port", (event) => {
  const port = event.ports[0];
  if (!port) return;
  // preload: MessagePort transfer to the page
  const g = globalThis as unknown as {
    postMessage: (message: unknown, targetOrigin: string, transfer?: unknown[]) => void;
  };
  g.postMessage({ channel: "pi-desktop-host-port" }, "*", [port]);
});

// ISSUE-016: buffer deep-link until renderer subscribes
let pendingDeepLinkSession: string | null = null;
const deepLinkListeners = new Set<(sessionId: string) => void>();
const menuEvents = [
  "new-session",
  "settings",
  "check-for-updates",
  "show-update",
  "switch-session",
  "export-diagnostics",
] as const satisfies readonly DesktopMenuEvent[];
const menuEventSet = new Set<string>(menuEvents);
const menuListeners = new Map<DesktopMenuEvent, Set<() => void>>();
const pendingMenuEvents = new Set<DesktopMenuEvent>();

ipcRenderer.on("deep-link:session", (_e, sessionId: string) => {
  if (deepLinkListeners.size === 0) {
    pendingDeepLinkSession = sessionId;
    return;
  }
  for (const cb of deepLinkListeners) {
    try {
      cb(sessionId);
    } catch {
      /* ignore */
    }
  }
});

// Main can send a menu command as soon as a newly created page finishes
// loading, before React effects subscribe. Buffer one pending command per
// fixed event so notification/menu navigation is not lost during startup.
for (const event of menuEvents) {
  ipcRenderer.on(`menu:${event}`, () => {
    const listeners = menuListeners.get(event);
    if (!listeners || listeners.size === 0) {
      pendingMenuEvents.add(event);
      return;
    }
    for (const listener of [...listeners]) {
      try {
        listener();
      } catch {
        /* ignore renderer listener failures */
      }
    }
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
  onDeepLinkSession: (cb) => {
    deepLinkListeners.add(cb);
    if (pendingDeepLinkSession) {
      const id = pendingDeepLinkSession;
      pendingDeepLinkSession = null;
      try {
        cb(id);
      } catch {
        /* ignore */
      }
    }
    return () => {
      deepLinkListeners.delete(cb);
    };
  },
  onMenu: (event, cb) => {
    if (!menuEventSet.has(event)) return () => undefined;
    const fixedEvent = event as DesktopMenuEvent;
    const listeners = menuListeners.get(fixedEvent) ?? new Set<() => void>();
    listeners.add(cb);
    menuListeners.set(fixedEvent, listeners);
    if (pendingMenuEvents.delete(fixedEvent)) {
      try {
        cb();
      } catch {
        /* ignore renderer listener failures */
      }
    }
    return () => {
      listeners.delete(cb);
      if (listeners.size === 0) menuListeners.delete(fixedEvent);
    };
  },
};

contextBridge.exposeInMainWorld("piBridge", bridge);

contextBridge.exposeInMainWorld("piDesktop", {
  platform: bridge.platform,
  isDesktop: true as const,
  getVersion: bridge.getVersion,
  notifyAgentEnd: bridge.notifyAgentEnd,
  setBadgeCount: bridge.setBadgeCount,
  openExternal: bridge.openExternal,
  showItemInFolder: bridge.showItemInFolder,
});
