import { randomUUID } from "node:crypto";
import { BrowserError } from "./browser-error.ts";

type InspectionRecord = {
  id: string;
  sessionId: string;
  tabId: string;
  generation: number;
  contentHash: string;
  viewportHash: string;
  createdAt: number;
};

export class BrowserInspectionStore {
  private readonly records = new Map<string, InspectionRecord>();
  private readonly now: () => number;
  private readonly ttlMs: number;
  private readonly maxRecords: number;

  constructor(now: () => number = Date.now, ttlMs = 10 * 60 * 1_000, maxRecords = 200) {
    this.now = now;
    this.ttlMs = ttlMs;
    this.maxRecords = maxRecords;
  }

  record(input: {
    sessionId: string;
    tabId: string;
    generation: number;
    contentHash: string;
    viewportHash: string;
    sinceInspectionId?: string;
  }): { inspectionId: string; changed: boolean } {
    this.prune();
    let changed = true;
    if (input.sinceInspectionId) {
      const prior = this.records.get(input.sinceInspectionId);
      if (!prior || prior.sessionId !== input.sessionId || prior.tabId !== input.tabId) {
        throw new BrowserError("INSPECTION_STALE", "Browser inspection id is stale or unavailable");
      }
      changed =
        prior.generation !== input.generation ||
        prior.contentHash !== input.contentHash ||
        prior.viewportHash !== input.viewportHash;
    }
    const inspectionId = randomUUID();
    this.records.set(inspectionId, {
      id: inspectionId,
      sessionId: input.sessionId,
      tabId: input.tabId,
      generation: input.generation,
      contentHash: input.contentHash,
      viewportHash: input.viewportHash,
      createdAt: this.now(),
    });
    this.prune();
    return { inspectionId, changed };
  }

  clearTab(tabId: string): void {
    for (const [id, record] of this.records) {
      if (record.tabId === tabId) this.records.delete(id);
    }
  }

  clearSession(sessionId: string): void {
    for (const [id, record] of this.records) {
      if (record.sessionId === sessionId) this.records.delete(id);
    }
  }

  clear(): void {
    this.records.clear();
  }

  size(): number {
    this.prune();
    return this.records.size;
  }

  private prune(): void {
    const cutoff = this.now() - this.ttlMs;
    for (const [id, record] of this.records) {
      if (record.createdAt < cutoff) this.records.delete(id);
    }
    while (this.records.size > this.maxRecords) {
      const oldest = this.records.keys().next().value as string | undefined;
      if (!oldest) break;
      this.records.delete(oldest);
    }
  }
}
