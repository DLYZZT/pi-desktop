import type { PiBridge } from "../contract/desktop";

declare global {
  interface Window {
    piBridge: PiBridge;
  }
}

export {};
