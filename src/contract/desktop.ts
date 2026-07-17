import type { ChannelId } from "../shared/channel-types";

export type HostStatus = "starting" | "ready" | "crashed" | "stopped";

export type DesktopMenuEvent =
  "new-session" | "settings" | "check-for-updates" | "show-update" | "switch-session" | "export-diagnostics";

export type UpdatePhase =
  "disabled" | "idle" | "checking" | "up-to-date" | "available" | "downloading" | "downloaded" | "installing" | "error";

export type UpdateErrorCode =
  | "UPDATE_OFFLINE"
  | "UPDATE_NOT_PUBLISHED"
  | "UPDATE_METADATA_INVALID"
  | "UPDATE_SIGNATURE_INVALID"
  | "UPDATE_DOWNLOAD_FAILED"
  | "UPDATE_BUSY"
  | "UPDATE_INVALID_STATE"
  | "UPDATE_UNSUPPORTED"
  | "UPDATE_UNKNOWN";

export interface DesktopUpdateState {
  phase: UpdatePhase;
  currentVersion: string;
  availableVersion?: string;
  releaseName?: string;
  releaseDate?: string;
  releaseNotes?: string;
  percent?: number;
  bytesPerSecond?: number;
  transferred?: number;
  total?: number;
  checkedAt?: string;
  automaticChecksEnabled: boolean;
  installBlockedByActiveSessions: boolean;
  canRetry: boolean;
  error?: { code: UpdateErrorCode; message: string };
}

export interface ChannelCredentialWrite {
  channel: ChannelId;
  accountId: string;
  credential: {
    token: string;
    providerAccountId: string;
    providerUsername?: string;
    baseUrl: string;
  };
}

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
  getUpdateState: () => Promise<DesktopUpdateState>;
  checkForUpdates: () => Promise<DesktopUpdateState>;
  downloadUpdate: () => Promise<DesktopUpdateState>;
  installUpdate: () => Promise<void>;
  setAutomaticUpdateChecks: (enabled: boolean) => Promise<DesktopUpdateState>;
  getHostStatus: () => Promise<HostStatus>;
  requestHostPort: () => void;
  openExternal: (url: string) => Promise<void>;
  showItemInFolder: (fsPath: string) => Promise<void>;
  selectDirectory: () => Promise<string | null>;
  setChannelCredential: (payload: ChannelCredentialWrite) => Promise<void>;
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
  onUpdateState: (cb: (state: DesktopUpdateState) => void) => () => void;
  onDeepLinkSession: (cb: (sessionId: string) => void) => () => void;
  onMenu: (event: DesktopMenuEvent, cb: () => void) => () => void;
}
