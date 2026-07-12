import type { PiBridge } from "../contract/desktop";

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
