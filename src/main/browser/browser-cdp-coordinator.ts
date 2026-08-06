import type { WebContents } from "electron";
import { BrowserError } from "./browser-error.ts";

export interface BrowserCdpEvent {
  method: string;
  params: Record<string, unknown>;
  sessionId?: string;
}

type CdpRecord = {
  contents: WebContents;
  temporaryUsers: number;
  keepReasons: Set<string>;
  domainRefs: Map<string, number>;
  listeners: Set<(event: BrowserCdpEvent) => void>;
  attachedByCoordinator: boolean;
  messageListener: (event: Electron.Event, method: string, params: Record<string, unknown>, sessionId?: string) => void;
  detachListener: () => void;
};

export class BrowserCdpCoordinator {
  private readonly records = new Map<string, CdpRecord>();

  register(tabId: string, contents: WebContents): void {
    this.disposeTab(tabId);
    const record: CdpRecord = {
      contents,
      temporaryUsers: 0,
      keepReasons: new Set(),
      domainRefs: new Map(),
      listeners: new Set(),
      attachedByCoordinator: false,
      messageListener: (_event, method, params, sessionId) => {
        const message: BrowserCdpEvent = {
          method,
          params: params && typeof params === "object" ? params : {},
          ...(sessionId ? { sessionId } : {}),
        };
        for (const listener of record.listeners) listener(message);
      },
      detachListener: () => {
        record.temporaryUsers = 0;
        record.keepReasons.clear();
        record.domainRefs.clear();
        record.attachedByCoordinator = false;
      },
    };
    contents.debugger.on("message", record.messageListener);
    contents.debugger.on("detach", record.detachListener);
    this.records.set(tabId, record);
  }

  acquire(tabId: string, keepReason?: string): () => void {
    const record = this.requireRecord(tabId);
    this.ensureAttached(record);
    record.temporaryUsers += 1;
    if (keepReason) record.keepReasons.add(keepReason);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      record.temporaryUsers = Math.max(0, record.temporaryUsers - 1);
      if (keepReason) record.keepReasons.delete(keepReason);
      this.detachIfIdle(record);
    };
  }

  keepAttached(tabId: string, reason: string): () => void {
    const record = this.requireRecord(tabId);
    this.ensureAttached(record);
    record.keepReasons.add(reason);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      record.keepReasons.delete(reason);
      this.detachIfIdle(record);
    };
  }

  async enableDomain(
    tabId: string,
    domain: string,
    params: Record<string, unknown> = {},
  ): Promise<() => Promise<void>> {
    if (!/^[A-Z][A-Za-z0-9]*$/.test(domain)) {
      throw new BrowserError("INVALID_BROWSER_REQUEST", "CDP domain name is invalid");
    }
    const record = this.requireRecord(tabId);
    this.ensureAttached(record);
    const refs = record.domainRefs.get(domain) ?? 0;
    if (refs === 0) await record.contents.debugger.sendCommand(`${domain}.enable`, params);
    record.domainRefs.set(domain, refs + 1);
    let released = false;
    return async () => {
      if (released) return;
      released = true;
      const current = record.domainRefs.get(domain) ?? 0;
      if (current <= 1) {
        record.domainRefs.delete(domain);
        if (!record.contents.isDestroyed() && record.contents.debugger.isAttached()) {
          await record.contents.debugger.sendCommand(`${domain}.disable`).catch(() => undefined);
        }
      } else {
        record.domainRefs.set(domain, current - 1);
      }
      this.detachIfIdle(record);
    };
  }

  subscribe(tabId: string, listener: (event: BrowserCdpEvent) => void): () => void {
    const record = this.requireRecord(tabId);
    record.listeners.add(listener);
    return () => record.listeners.delete(listener);
  }

  async sendCommand<T = unknown>(
    tabId: string,
    method: string,
    params?: Record<string, unknown>,
    sessionId?: string,
  ): Promise<T> {
    const record = this.requireRecord(tabId);
    this.ensureAttached(record);
    return (await record.contents.debugger.sendCommand(method, params, sessionId)) as T;
  }

  releaseKeep(tabId: string, reason: string): void {
    const record = this.records.get(tabId);
    if (!record) return;
    record.keepReasons.delete(reason);
    this.detachIfIdle(record);
  }

  clearKeeps(tabId: string): void {
    const record = this.records.get(tabId);
    if (!record) return;
    record.keepReasons.clear();
    this.detachIfIdle(record);
  }

  isAttached(tabId: string): boolean {
    const record = this.records.get(tabId);
    return Boolean(record && !record.contents.isDestroyed() && record.contents.debugger.isAttached());
  }

  countAttached(): number {
    return [...this.records.values()].filter(
      ({ contents }) => !contents.isDestroyed() && contents.debugger.isAttached(),
    ).length;
  }

  disposeTab(tabId: string): void {
    const record = this.records.get(tabId);
    if (!record) return;
    this.records.delete(tabId);
    record.listeners.clear();
    record.keepReasons.clear();
    record.domainRefs.clear();
    if (!record.contents.isDestroyed()) {
      record.contents.debugger.removeListener("message", record.messageListener);
      record.contents.debugger.removeListener("detach", record.detachListener);
      if (record.attachedByCoordinator && record.contents.debugger.isAttached()) {
        try {
          record.contents.debugger.detach();
        } catch {
          // The renderer may be closing concurrently.
        }
      }
    }
  }

  dispose(): void {
    for (const tabId of [...this.records.keys()]) this.disposeTab(tabId);
  }

  private requireRecord(tabId: string): CdpRecord {
    const record = this.records.get(tabId);
    if (!record || record.contents.isDestroyed()) {
      throw new BrowserError("TAB_CRASHED", "Browser tab CDP target is unavailable", { retryable: true });
    }
    return record;
  }

  private ensureAttached(record: CdpRecord): void {
    if (record.contents.debugger.isAttached()) return;
    try {
      record.contents.debugger.attach("1.3");
      record.attachedByCoordinator = true;
    } catch (error) {
      throw new BrowserError("TAB_CRASHED", "Could not attach to the Browser tab", {
        retryable: true,
        cause: error,
      });
    }
  }

  private detachIfIdle(record: CdpRecord): void {
    if (
      record.temporaryUsers > 0 ||
      record.keepReasons.size > 0 ||
      record.domainRefs.size > 0 ||
      !record.attachedByCoordinator ||
      record.contents.isDestroyed() ||
      !record.contents.debugger.isAttached()
    ) {
      return;
    }
    record.attachedByCoordinator = false;
    try {
      record.contents.debugger.detach();
    } catch {
      // The target can detach while a release callback is running.
    }
  }
}
