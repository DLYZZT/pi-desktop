/**
 * Preload — expose piBridge only (sandbox + contextIsolation).
 *
 * MessagePort MUST NOT cross contextBridge via Promise resolve — that silently
 * breaks the port. Use window.postMessage transfer instead (Electron docs).
 */
import { contextBridge, ipcRenderer } from "electron";

export type HostStatus = "starting" | "ready" | "crashed" | "stopped";

export type PiBridge = {
  platform: NodeJS.Platform;
  isDesktop: true;
  getVersion: () => Promise<string>;
  getHostStatus: () => Promise<HostStatus>;
  /** Ask main for a Host MessagePort; renderer receives it via window message. */
  requestHostPort: () => void;
  openExternal: (url: string) => Promise<void>;
  showItemInFolder: (fsPath: string) => Promise<void>;
  selectDirectory: () => Promise<string | null>;
  saveFile: (opts: {
    content: string;
    defaultPath?: string;
    filters?: { name: string; extensions: string[] }[];
  }) => Promise<string | null>;
  notifyAgentEnd: (payload: { sessionId: string; title?: string }) => void;
  setBadgeCount: (n: number) => void;
  getUiState: () => Promise<Record<string, unknown>>;
  setUiState: (patch: Record<string, unknown>) => Promise<void>;
  getThemeSource: () => Promise<"system" | "light" | "dark">;
  setThemeSource: (source: "system" | "light" | "dark") => Promise<void>;
  openLogs: () => Promise<void>;
  onHostStatus: (cb: (s: { status: HostStatus; detail?: string }) => void) => () => void;
  onDeepLinkSession: (cb: (sessionId: string) => void) => () => void;
  onMenu: (event: string, cb: () => void) => () => void;
};

// Deliver MessagePort to the page via window.postMessage (transferable).
ipcRenderer.on("desktop:host-port", (event) => {
  const port = event.ports[0];
  if (!port) return;
  window.postMessage({ channel: "pi-desktop-host-port" }, "*", [port]);
});

const bridge: PiBridge = {
  platform: process.platform,
  isDesktop: true,
  getVersion: () => ipcRenderer.invoke("desktop:get-version"),
  getHostStatus: () => ipcRenderer.invoke("desktop:get-host-status"),
  requestHostPort: () => {
    ipcRenderer.send("desktop:connect-host");
  },
  openExternal: (url) => ipcRenderer.invoke("desktop:open-external", url),
  showItemInFolder: (fsPath) => ipcRenderer.invoke("desktop:show-item-in-folder", fsPath),
  selectDirectory: () => ipcRenderer.invoke("desktop:select-directory"),
  saveFile: (opts) => ipcRenderer.invoke("desktop:save-file", opts),
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
  onHostStatus: (cb) => {
    const handler = (_: Electron.IpcRendererEvent, data: { status: HostStatus; detail?: string }) =>
      cb(data);
    ipcRenderer.on("host:status", handler);
    return () => ipcRenderer.removeListener("host:status", handler);
  },
  onDeepLinkSession: (cb) => {
    const handler = (_: Electron.IpcRendererEvent, sessionId: string) => cb(sessionId);
    ipcRenderer.on("deep-link:session", handler);
    return () => ipcRenderer.removeListener("deep-link:session", handler);
  },
  onMenu: (event, cb) => {
    const channel = `menu:${event}`;
    const handler = () => cb();
    ipcRenderer.on(channel, handler);
    return () => ipcRenderer.removeListener(channel, handler);
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
