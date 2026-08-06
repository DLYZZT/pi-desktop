import { randomUUID } from "node:crypto";
import type {
  BrowserAgentAuthorizationDecision,
  BrowserAgentAuthorizationRequest,
  BrowserPermissionLevel,
  BrowserPersistentSessionPermission,
} from "../../contract/browser.ts";
import { BrowserError } from "./browser-error.ts";

const RANK: Record<BrowserPermissionLevel | "ask" | "deny" | "inherit", number> = {
  inherit: -1,
  ask: 0,
  deny: 0,
  none: 0,
  read: 1,
  interact: 2,
  advanced: 3,
};

type RequiredPermission = "read" | "interact" | "advanced";
type ResolveOutcome = "denied" | "allowed-session" | "persistent-policy" | "timeout" | "cancelled";
type Pending = {
  request: BrowserAgentAuthorizationRequest;
  promise: Promise<void>;
  resolve: () => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

export interface BrowserAuthorizationCoordinatorOptions {
  getPersistentPermission: (sessionId: string) => Exclude<BrowserPersistentSessionPermission, "inherit">;
  isRendererAvailable: () => boolean;
  grant: (
    sessionId: string,
    permission: RequiredPermission,
    source: "local" | "channel",
    grantSource: "user-prompt" | "persistent-policy",
  ) => void;
  emitRequest: (request: BrowserAgentAuthorizationRequest) => void;
  emitResolved: (requestId: string, outcome: ResolveOutcome) => void;
  now?: () => number;
  createId?: () => string;
  timeoutMs?: number;
  denyCooldownMs?: number;
}

export class BrowserAuthorizationCoordinator {
  private readonly pendingBySession = new Map<string, Pending>();
  private readonly pendingById = new Map<string, Pending>();
  private readonly queue: Pending[] = [];
  private active: Pending | null = null;
  private readonly deniedUntil = new Map<string, number>();
  private readonly now: () => number;
  private readonly createId: () => string;
  private readonly timeoutMs: number;
  private readonly denyCooldownMs: number;
  private readonly options: BrowserAuthorizationCoordinatorOptions;

  constructor(options: BrowserAuthorizationCoordinatorOptions) {
    this.options = options;
    this.now = options.now ?? Date.now;
    this.createId = options.createId ?? randomUUID;
    this.timeoutMs = options.timeoutMs ?? 60_000;
    this.denyCooldownMs = options.denyCooldownMs ?? 2_000;
  }

  async request(sessionId: string, source: "local" | "channel", minimumPermission: RequiredPermission): Promise<void> {
    const persistent = this.options.getPersistentPermission(sessionId);
    if (persistent === "deny") {
      throw new BrowserError("USER_DENIED", "Browser access is denied by the persistent policy");
    }
    if (RANK[persistent] >= RANK[minimumPermission]) {
      this.options.grant(sessionId, minimumPermission, source, "persistent-policy");
      return;
    }
    if ((this.deniedUntil.get(sessionId) ?? 0) > this.now()) {
      throw new BrowserError("USER_DENIED", "Browser access was recently denied");
    }
    if (!this.options.isRendererAvailable()) {
      throw new BrowserError("CAPABILITY_DISABLED", "The local authorization UI is unavailable");
    }

    const existing = this.pendingBySession.get(sessionId);
    if (existing) {
      if (RANK[existing.request.minimumPermission] >= RANK[minimumPermission]) {
        await existing.promise;
        return;
      }
      try {
        await existing.promise;
      } catch {
        // A higher-tier request is independently evaluated after the current
        // dialog resolves; it never stacks a second dialog.
      }
      return this.request(sessionId, source, minimumPermission);
    }

    const createdAt = this.now();
    const request: BrowserAgentAuthorizationRequest = {
      id: this.createId(),
      sessionId,
      source,
      methodCategory: minimumPermission,
      minimumPermission,
      createdAt,
      expiresAt: createdAt + this.timeoutMs,
    };
    let resolvePromise!: () => void;
    let rejectPromise!: (error: Error) => void;
    const promise = new Promise<void>((resolve, reject) => {
      resolvePromise = resolve;
      rejectPromise = reject;
    });
    const pending: Pending = {
      request,
      promise,
      resolve: resolvePromise,
      reject: rejectPromise,
      timer: setTimeout(() => {
        this.finish(pending, "timeout", new BrowserError("AUTHORIZATION_TIMEOUT", "Browser authorization timed out"));
      }, this.timeoutMs),
    };
    this.pendingBySession.set(sessionId, pending);
    this.pendingById.set(request.id, pending);
    if (this.active) this.queue.push(pending);
    else this.activate(pending);
    return promise;
  }

  respond(requestId: string, decision: BrowserAgentAuthorizationDecision): void {
    if (decision !== "deny" && decision !== "allow-session") {
      throw new BrowserError("INVALID_BROWSER_REQUEST", "Browser authorization decision is invalid");
    }
    const pending = this.pendingById.get(requestId);
    if (!pending || pending.request.expiresAt <= this.now()) {
      throw new BrowserError("INVALID_BROWSER_REQUEST", "Browser authorization request is stale");
    }
    if (decision === "deny") {
      this.deniedUntil.set(pending.request.sessionId, this.now() + this.denyCooldownMs);
      this.finish(pending, "denied", new BrowserError("USER_DENIED", "The user denied Browser access"));
      return;
    }
    this.options.grant(
      pending.request.sessionId,
      pending.request.minimumPermission,
      pending.request.source,
      "user-prompt",
    );
    this.finish(pending, "allowed-session");
  }

  persistentPolicyChanged(sessionId: string): void {
    const pending = this.pendingBySession.get(sessionId);
    if (!pending) return;
    const permission = this.options.getPersistentPermission(sessionId);
    if (permission === "deny") {
      this.finish(pending, "denied", new BrowserError("USER_DENIED", "Browser access is denied by settings"));
      return;
    }
    if (RANK[permission] >= RANK[pending.request.minimumPermission]) {
      this.options.grant(sessionId, pending.request.minimumPermission, pending.request.source, "persistent-policy");
      this.finish(pending, "persistent-policy");
    }
  }

  cancelSession(sessionId: string): void {
    const pending = this.pendingBySession.get(sessionId);
    if (pending) {
      this.finish(pending, "cancelled", new BrowserError("CAPABILITY_DISABLED", "Browser authorization was cancelled"));
    }
    this.deniedUntil.delete(sessionId);
  }

  cancelAll(): void {
    const active = this.active;
    for (const pending of [...this.pendingById.values()].filter((candidate) => candidate !== active)) {
      this.finish(pending, "cancelled", new BrowserError("CAPABILITY_DISABLED", "Browser authorization was cancelled"));
    }
    if (active) {
      this.finish(active, "cancelled", new BrowserError("CAPABILITY_DISABLED", "Browser authorization was cancelled"));
    }
    this.deniedUntil.clear();
  }

  listPending(): BrowserAgentAuthorizationRequest[] {
    return [...this.pendingById.values()].map(({ request }) => structuredClone(request));
  }

  private finish(pending: Pending, outcome: ResolveOutcome, error?: Error): void {
    if (!this.pendingById.has(pending.request.id)) return;
    clearTimeout(pending.timer);
    this.pendingById.delete(pending.request.id);
    const queueIndex = this.queue.indexOf(pending);
    if (queueIndex >= 0) this.queue.splice(queueIndex, 1);
    if (this.pendingBySession.get(pending.request.sessionId) === pending) {
      this.pendingBySession.delete(pending.request.sessionId);
    }
    if (this.active === pending) this.active = null;
    this.options.emitResolved(pending.request.id, outcome);
    if (error) pending.reject(error);
    else pending.resolve();
    if (!this.active) {
      const next = this.queue.shift();
      if (next && this.pendingById.has(next.request.id)) this.activate(next);
    }
  }

  private activate(pending: Pending): void {
    this.active = pending;
    this.options.emitRequest(structuredClone(pending.request));
  }
}
