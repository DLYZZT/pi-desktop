export type HostStatus = "starting" | "ready" | "crashed" | "stopped";

export type PiBridge = {
  platform: NodeJS.Platform;
  isDesktop: true;
  getVersion: () => Promise<string>;
  getHostStatus: () => Promise<HostStatus>;
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

declare global {
  interface Window {
    piBridge: PiBridge;
    piDesktop?: {
      platform: NodeJS.Platform;
      isDesktop: true;
      getVersion: () => Promise<string>;
      notifyAgentEnd: (payload: { sessionId: string; title?: string }) => void;
      setBadgeCount: (n: number) => void;
      openExternal: (url: string) => Promise<void>;
      showItemInFolder: (fsPath: string) => Promise<void>;
    };
  }
}

export {};
