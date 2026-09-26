import type { SessionInfo } from "./types";
import type { SessionStatsInfo } from "./pi-types";
import type { SessionRuntimeState } from "@contract/types";

export interface SessionPresentation {
  sessionId: string | null;
  info: SessionInfo | null;
  stats: SessionStatsInfo | null;
  contextUsage: NonNullable<SessionRuntimeState["contextUsage"]> | null;
}

/** One per window. The active chat publishes; title and info views subscribe. */
export class SessionPresentationStore {
  private snapshot: SessionPresentation | null = null;
  private fingerprint = "null";
  private owner: object | null = null;
  private listeners = new Set<() => void>();

  getSnapshot = (): SessionPresentation | null => this.snapshot;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  private publish(next: SessionPresentation | null): void {
    // Only small presentation records enter this store: no message history,
    // stream payloads or system prompts. Value equality also covers new fields
    // without maintaining a separate delimiter-joined list of selected scalars.
    const fingerprint = JSON.stringify(next, (_key, value: unknown) => {
      if (!value || typeof value !== "object" || Array.isArray(value)) return value;
      return Object.fromEntries(Object.entries(value).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
    });
    if (fingerprint === this.fingerprint) return;
    this.fingerprint = fingerprint;
    this.snapshot = next;
    for (const listener of [...this.listeners]) listener();
  }

  createPublisher() {
    const owner = {};
    return {
      activate: () => {
        this.owner = owner;
        this.publish(null);
      },
      update: (next: SessionPresentation) => {
        if (this.owner === owner) this.publish(next);
      },
      release: () => {
        if (this.owner !== owner) return;
        this.owner = null;
        this.publish(null);
      },
    };
  }
}
