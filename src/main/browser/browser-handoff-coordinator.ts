import { randomUUID } from "node:crypto";
import type {
  BrowserHandoffDialog,
  BrowserHandoffKind,
  BrowserHandoffOutcome,
  BrowserHandoffRequest,
  BrowserHandoffResolution,
} from "../../contract/browser.ts";
import { BrowserError } from "./browser-error.ts";

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1_000;
const MAX_PENDING = 16;

type Pending = {
  request: BrowserHandoffRequest;
  resolve: (resolution: BrowserHandoffResolution) => void;
  timer: ReturnType<typeof setTimeout>;
};

export interface BrowserHandoffCoordinatorOptions {
  isRendererAvailable: () => boolean;
  emitRequest: (request: BrowserHandoffRequest) => void;
  emitResolved: (handoffId: string, outcome: BrowserHandoffOutcome) => void;
  now?: () => number;
  createId?: () => string;
  timeoutMs?: number;
  maxPending?: number;
}

export interface BrowserHandoffInput {
  sessionId: string;
  tabId: string;
  kind: BrowserHandoffKind;
  origin: string;
  title: string;
  message: string;
  timeoutMs?: number;
  dialog?: BrowserHandoffDialog;
}

/**
 * One user-facing handoff at a time. Login, captcha, page dialogs and the
 * local file picker all pause the Agent on the same channel so two prompts can
 * never stack or steal each other's focus.
 */
export class BrowserHandoffCoordinator {
  private readonly options: BrowserHandoffCoordinatorOptions;
  private readonly pendingById = new Map<string, Pending>();
  private readonly pendingByTab = new Map<string, Pending>();
  private readonly queue: Pending[] = [];
  private active: Pending | null = null;
  private readonly now: () => number;
  private readonly createId: () => string;
  private readonly timeoutMs: number;
  private readonly maxPending: number;

  constructor(options: BrowserHandoffCoordinatorOptions) {
    this.options = options;
    this.now = options.now ?? Date.now;
    this.createId = options.createId ?? randomUUID;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxPending = Math.max(1, options.maxPending ?? MAX_PENDING);
  }

  list(): BrowserHandoffRequest[] {
    const requests: BrowserHandoffRequest[] = [];
    if (this.active) requests.push(structuredClone(this.active.request));
    for (const pending of this.queue) requests.push(structuredClone(pending.request));
    return requests;
  }

  request(input: BrowserHandoffInput): Promise<BrowserHandoffResolution> {
    if (!this.options.isRendererAvailable()) {
      return Promise.reject(
        new BrowserError("CAPABILITY_DISABLED", "The local Browser handoff UI is unavailable", {
          retryable: false,
          recovery: { reason: "policy-denied", remediation: "ask-user" },
        }),
      );
    }
    const existing = this.pendingByTab.get(input.tabId);
    if (existing) return this.waitFor(existing);
    if (this.pendingById.size >= this.maxPending) {
      return Promise.reject(
        new BrowserError("BROWSER_CALL_BUDGET_EXCEEDED", "Too many Browser handoff requests are pending", {
          retryable: false,
          recovery: { reason: "policy-denied", remediation: "ask-user" },
        }),
      );
    }

    const createdAt = this.now();
    const timeoutMs = clampTimeout(input.timeoutMs ?? this.timeoutMs);
    const request: BrowserHandoffRequest = {
      id: this.createId(),
      sessionId: input.sessionId,
      tabId: input.tabId,
      kind: input.kind,
      origin: input.origin.slice(0, 512),
      title: input.title.slice(0, 512),
      message: input.message.slice(0, 2_000),
      createdAt,
      expiresAt: createdAt + timeoutMs,
      ...(input.dialog ? { dialog: input.dialog } : {}),
    };

    let resolve!: (resolution: BrowserHandoffResolution) => void;
    const promise = new Promise<BrowserHandoffResolution>((done) => {
      resolve = done;
    });
    const pending: Pending = {
      request,
      resolve,
      timer: setTimeout(() => {
        this.finish(pending, { handoffId: request.id, outcome: "timeout" });
      }, timeoutMs),
    };
    this.pendingById.set(request.id, pending);
    this.pendingByTab.set(request.tabId, pending);
    if (this.active) this.queue.push(pending);
    else this.activate(pending);
    return promise;
  }

  respond(
    handoffId: string,
    decision: {
      outcome: Exclude<BrowserHandoffOutcome, "timeout">;
      accept?: boolean;
      promptText?: string;
      note?: string;
    },
  ): void {
    if (decision.outcome !== "completed" && decision.outcome !== "cancelled") {
      throw new BrowserError("INVALID_BROWSER_REQUEST", "Browser handoff outcome is invalid");
    }
    const pending = this.pendingById.get(handoffId);
    if (!pending) {
      throw new BrowserError("INVALID_BROWSER_REQUEST", "Browser handoff request is stale");
    }
    this.finish(pending, {
      handoffId,
      outcome: decision.outcome,
      ...(decision.accept === undefined ? {} : { accept: decision.accept }),
      ...(decision.promptText === undefined ? {} : { promptText: decision.promptText.slice(0, 8_192) }),
      ...(decision.note === undefined ? {} : { note: decision.note.slice(0, 1_000) }),
    });
  }

  cancelTab(tabId: string): void {
    const pending = this.pendingByTab.get(tabId);
    if (pending) this.finish(pending, { handoffId: pending.request.id, outcome: "cancelled" });
  }

  cancelSession(sessionId: string): void {
    for (const pending of [...this.pendingById.values()]) {
      if (pending.request.sessionId === sessionId) {
        this.finish(pending, { handoffId: pending.request.id, outcome: "cancelled" });
      }
    }
  }

  cancelAll(): void {
    for (const pending of [...this.pendingById.values()]) {
      this.finish(pending, { handoffId: pending.request.id, outcome: "cancelled" });
    }
  }

  private waitFor(pending: Pending): Promise<BrowserHandoffResolution> {
    // A second request for the same tab joins the existing handoff. The
    // resolution is delivered to every waiter; timeouts are reported once.
    return new Promise<BrowserHandoffResolution>((resolve) => {
      const original = pending.resolve;
      pending.resolve = (resolution) => {
        original(resolution);
        resolve(resolution);
      };
    });
  }

  private activate(pending: Pending): void {
    this.active = pending;
    this.options.emitRequest(structuredClone(pending.request));
  }

  private finish(pending: Pending, resolution: BrowserHandoffResolution): void {
    if (!this.pendingById.has(pending.request.id)) return;
    clearTimeout(pending.timer);
    this.pendingById.delete(pending.request.id);
    this.pendingByTab.delete(pending.request.tabId);
    const queueIndex = this.queue.indexOf(pending);
    if (queueIndex >= 0) this.queue.splice(queueIndex, 1);
    if (this.active === pending) this.active = null;
    this.options.emitResolved(pending.request.id, resolution.outcome);
    pending.resolve(structuredClone(resolution));
    const next = this.queue.shift();
    if (next) this.activate(next);
  }
}

function clampTimeout(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_TIMEOUT_MS;
  return Math.max(1, Math.min(30 * 60 * 1_000, Math.round(value)));
}
