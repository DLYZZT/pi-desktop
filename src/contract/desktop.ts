export type HostStatus = "starting" | "ready" | "crashed" | "stopped";

export interface SaveTextFileOptions {
  content: string;
  defaultPath?: string;
  filters?: { name: string; extensions: string[] }[];
}

export interface SaveBinaryFileOptions {
  base64: string;
  defaultPath?: string;
}

/** The complete, shared preload surface exposed to the sandboxed renderer. */
export interface PiBridge {
  platform: NodeJS.Platform;
  isDesktop: true;
  getVersion: () => Promise<string>;
  getHostStatus: () => Promise<HostStatus>;
  requestHostPort: () => void;
  openExternal: (url: string) => Promise<void>;
  showItemInFolder: (fsPath: string) => Promise<void>;
  selectDirectory: () => Promise<string | null>;
  saveFile: (opts: SaveTextFileOptions) => Promise<string | null>;
  saveBinaryFile: (opts: SaveBinaryFileOptions) => Promise<string | null>;
  createHtmlPreview: (content: string, filePath: string, sourceSessionId?: string | null) => Promise<string>;
  releaseHtmlPreview: (previewUrl: string) => Promise<void>;
  notifyAgentEnd: (payload: { sessionId: string; title?: string }) => void;
  setBadgeCount: (n: number) => void;
  getUiState: () => Promise<Record<string, unknown>>;
  setUiState: (patch: Record<string, unknown>) => Promise<void>;
  getThemeSource: () => Promise<"system" | "light" | "dark">;
  setThemeSource: (source: "system" | "light" | "dark") => Promise<void>;
  openLogs: () => Promise<void>;
  exportDiagnostics: () => Promise<string | null>;
  clearBadge: () => void;
  onHostStatus: (cb: (s: { status: HostStatus; detail?: string }) => void) => () => void;
  onHostRestarted: (cb: (payload: { reason: string }) => void) => () => void;
  onHostCrashed: (cb: (payload: { detail?: string }) => void) => () => void;
  onDeepLinkSession: (cb: (sessionId: string) => void) => () => void;
  onMenu: (event: string, cb: () => void) => () => void;
}
