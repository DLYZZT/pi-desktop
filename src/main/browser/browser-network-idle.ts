import type { BrowserCdpCoordinator } from "./browser-cdp-coordinator.ts";
import { BrowserError } from "./browser-error.ts";
import { abortableDelay } from "./browser-action-timing.ts";

const IGNORED_TYPES = new Set(["WebSocket", "EventSource"]);

/**
 * A short-lived Network-domain probe used by `browser_wait(network-idle)`.
 * It counts in-flight document/XHR/fetch requests and waits for a quiet
 * window. It is scoped to one wait call so an idle Agent does not hold CDP.
 */
export class BrowserNetworkIdleProbe {
  private readonly cdp: BrowserCdpCoordinator;

  constructor(cdp: BrowserCdpCoordinator) {
    this.cdp = cdp;
  }

  async wait(tabId: string, options: { timeoutMs: number; quietMs?: number; signal?: AbortSignal }): Promise<boolean> {
    let release: (() => Promise<void>) | undefined;
    try {
      release = await this.cdp.enableDomain(tabId, "Network");
    } catch {
      return false;
    }
    const inflight = new Set<string>();
    let lastActivity = Date.now();
    const unsubscribe = this.cdp.subscribe(tabId, (event) => {
      const params = event.params as { requestId?: unknown; type?: unknown; request?: { url?: unknown } };
      const requestId = typeof params.requestId === "string" ? params.requestId : undefined;
      if (!requestId) return;
      if (event.method === "Network.requestWillBeSent") {
        const type = typeof params.type === "string" ? params.type : "";
        const url = typeof params.request?.url === "string" ? params.request.url : "";
        if (IGNORED_TYPES.has(type) || /^(?:data|blob):/i.test(url)) return;
        inflight.add(requestId);
        lastActivity = Date.now();
        return;
      }
      if (event.method === "Network.loadingFinished" || event.method === "Network.loadingFailed") {
        if (inflight.delete(requestId)) lastActivity = Date.now();
      }
    });
    const quietMs = Math.max(50, Math.min(5_000, options.quietMs ?? 500));
    try {
      const deadline = Date.now() + options.timeoutMs;
      while (Date.now() < deadline) {
        if (options.signal?.aborted) {
          throw new BrowserError("USER_TOOK_CONTROL", "User took control of the Browser tab");
        }
        if (inflight.size === 0 && Date.now() - lastActivity >= quietMs) return true;
        await abortableDelay(50, options.signal);
      }
      throw new BrowserError("ACTION_TIMEOUT", "Browser network did not become idle", {
        retryable: true,
        recovery: { reason: "transient-network", remediation: "wait-and-retry-once", retryAfterMs: 250 },
      });
    } finally {
      unsubscribe();
      await release().catch(() => undefined);
    }
  }
}
