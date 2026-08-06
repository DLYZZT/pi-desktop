import { randomUUID } from "node:crypto";
import type {
  BrowserAdvancedRuntimePolicy,
  BrowserCapabilityLease,
  BrowserCapabilitySnapshot,
  BrowserHostRequestContext,
  BrowserPermissionLevel,
  BrowserSessionGrantInput,
  BrowserSettingsV2,
} from "../../contract/browser.ts";
import { BrowserError } from "./browser-error.ts";

const PERMISSION_RANK: Record<BrowserPermissionLevel, number> = {
  none: 0,
  read: 1,
  interact: 2,
  advanced: 3,
};
const DEFAULT_GRANT_TTL_MS = 8 * 60 * 60 * 1_000;
const DEFAULT_LEASE_TTL_MS = 15 * 60 * 1_000;

type SessionGrant = BrowserSessionGrantInput & { expiresAt: number };

export interface BrowserPolicyEngineOptions {
  now?: () => number;
  createId?: () => string;
  grantTtlMs?: number;
  leaseTtlMs?: number;
}

export class BrowserPolicyEngine {
  private revision = 0;
  private settings: BrowserSettingsV2;
  private readonly grants = new Map<string, SessionGrant>();
  private readonly leases = new Map<string, BrowserCapabilityLease>();
  private readonly listeners = new Set<(snapshot: BrowserCapabilitySnapshot) => void>();
  private readonly now: () => number;
  private readonly createId: () => string;
  private readonly grantTtlMs: number;
  private readonly leaseTtlMs: number;

  constructor(settings: BrowserSettingsV2, options: BrowserPolicyEngineOptions = {}) {
    this.settings = structuredClone(settings);
    this.now = options.now ?? Date.now;
    this.createId = options.createId ?? randomUUID;
    this.grantTtlMs = options.grantTtlMs ?? DEFAULT_GRANT_TTL_MS;
    this.leaseTtlMs = options.leaseTtlMs ?? DEFAULT_LEASE_TTL_MS;
  }

  subscribe(listener: (snapshot: BrowserCapabilitySnapshot) => void): () => void {
    this.listeners.add(listener);
    listener(this.getSnapshot());
    return () => this.listeners.delete(listener);
  }

  getRevision(): number {
    return this.revision;
  }

  getSettings(): BrowserSettingsV2 {
    return structuredClone(this.settings);
  }

  getAdvancedRuntimePolicy(): BrowserAdvancedRuntimePolicy {
    const advanced = this.settings.advancedBrowserMode;
    if (!advanced.enabled) return createDisabledAdvancedRuntimePolicy();
    return {
      enabled: true,
      removeSiteSecurityHeaders: true,
      disableWebSecurity: true,
      allowInsecureContent: true,
      certificateBypassDomains: [...advanced.certificateBypassDomains],
      unrestrictedRawCdp: true,
    };
  }

  isAdvancedEnabled(): boolean {
    return this.settings.advancedBrowserMode.enabled;
  }

  isHighRiskPermissionEnabled(): boolean {
    return this.isAdvancedEnabled();
  }

  updateSettings(settings: BrowserSettingsV2): BrowserCapabilitySnapshot {
    this.settings = structuredClone(settings);
    if (!settings.enabled || !settings.automation.enabled) this.grants.clear();
    if (!settings.advancedBrowserMode.enabled) this.downgradeAdvancedGrants();
    this.bumpRevision();
    return this.getSnapshot();
  }

  grantSession(input: BrowserSessionGrantInput): BrowserCapabilityLease | undefined {
    const sessionId = validateSessionId(input.sessionId);
    if (!this.settings.enabled) throw new BrowserError("BROWSER_DISABLED", "The built-in browser is disabled");
    if (!this.settings.automation.enabled) {
      throw new BrowserError("CAPABILITY_DISABLED", "Agent browser tools are disabled");
    }
    if (input.source === "channel" && !this.settings.automation.allowChannelSessions) {
      throw new BrowserError("CAPABILITY_DISABLED", "Browser access for channel sessions is disabled");
    }
    if (input.permission === "advanced") {
      if (!this.isHighRiskPermissionEnabled()) {
        throw new BrowserError("ADVANCED_CONFIRMATION_REQUIRED", "Advanced browser capabilities are disabled");
      }
    }
    const requestedTtl = input.expiresInMs ?? this.grantTtlMs;
    const ttl = Math.max(1_000, Math.min(requestedTtl, this.grantTtlMs));
    this.grants.set(sessionId, { ...input, sessionId, expiresAt: this.now() + ttl });
    this.bumpRevision();
    return input.permission === "none" ? undefined : this.issueLease(sessionId);
  }

  revokeSession(sessionId: string): BrowserCapabilitySnapshot {
    const normalized = validateSessionId(sessionId);
    this.grants.delete(normalized);
    for (const [id, lease] of this.leases) {
      if (lease.sessionId === normalized) this.leases.delete(id);
    }
    this.bumpRevision();
    return this.getSnapshot();
  }

  revokeAll(): BrowserCapabilitySnapshot {
    this.grants.clear();
    this.bumpRevision();
    return this.getSnapshot();
  }

  issueLease(sessionId: string): BrowserCapabilityLease {
    this.pruneExpired();
    const normalized = validateSessionId(sessionId);
    const grant = this.grants.get(normalized);
    if (!grant || grant.permission === "none") {
      throw new BrowserError("CAPABILITY_DISABLED", "This session has no Browser permission");
    }
    if (grant.permission === "advanced" && !this.isHighRiskPermissionEnabled()) {
      throw new BrowserError("CAPABILITY_DISABLED", "Advanced Browser permission is no longer enabled");
    }
    const lease: BrowserCapabilityLease = {
      id: this.createId(),
      sessionId: normalized,
      permission: grant.permission,
      policyRevision: this.revision,
      expiresAt: Math.min(grant.expiresAt, this.now() + this.leaseTtlMs),
    };
    this.leases.set(lease.id, lease);
    return structuredClone(lease);
  }

  getLeaseForSession(sessionId: string): BrowserCapabilityLease | undefined {
    this.pruneExpired();
    const normalized = validateSessionId(sessionId);
    const lease = [...this.leases.values()]
      .filter((candidate) => candidate.sessionId === normalized && candidate.policyRevision === this.revision)
      .sort((left, right) => right.expiresAt - left.expiresAt)[0];
    return lease ? structuredClone(lease) : undefined;
  }

  assertRequest(context: BrowserHostRequestContext, required: BrowserPermissionLevel): BrowserCapabilityLease {
    this.pruneExpired();
    if (!this.settings.enabled) throw new BrowserError("BROWSER_DISABLED", "The built-in browser is disabled");
    if (!this.settings.automation.enabled) {
      throw new BrowserError("CAPABILITY_DISABLED", "Agent browser tools are disabled");
    }
    if (!context.requestId || context.requestId.length > 256 || /[\0\r\n]/.test(context.requestId)) {
      throw new BrowserError("INVALID_BROWSER_REQUEST", "Browser requestId is invalid");
    }
    if (context.policyRevision !== this.revision) {
      throw new BrowserError("POLICY_REVISION_MISMATCH", "Browser policy changed; refresh capabilities", {
        retryable: true,
        details: { expectedRevision: this.revision },
      });
    }
    const lease = this.leases.get(context.capabilityLeaseId);
    if (!lease || lease.expiresAt <= this.now()) {
      throw new BrowserError("CAPABILITY_LEASE_EXPIRED", "Browser capability lease expired", { retryable: true });
    }
    if (lease.policyRevision !== this.revision || lease.sessionId !== context.sessionId) {
      throw new BrowserError("CAPABILITY_LEASE_EXPIRED", "Browser capability lease is no longer valid", {
        retryable: true,
      });
    }
    if (PERMISSION_RANK[lease.permission] < PERMISSION_RANK[required]) {
      throw new BrowserError("CAPABILITY_DISABLED", `Browser ${required} permission is required`);
    }
    if (required === "advanced" && !this.isHighRiskPermissionEnabled()) {
      throw new BrowserError("ADVANCED_CONFIRMATION_REQUIRED", "Advanced browser capabilities are disabled");
    }
    return structuredClone(lease);
  }

  getSnapshot(): BrowserCapabilitySnapshot {
    this.pruneExpired();
    const sessionPermissions: Record<string, BrowserPermissionLevel> = {};
    for (const [sessionId, grant] of this.grants) sessionPermissions[sessionId] = grant.permission;
    return {
      revision: this.revision,
      browserEnabled: this.settings.enabled,
      automationEnabled: this.settings.automation.enabled,
      advancedEnabled: this.isHighRiskPermissionEnabled(),
      sessionPermissions,
      generatedAt: this.now(),
    };
  }

  private bumpRevision(): void {
    this.revision++;
    this.leases.clear();
    const snapshot = this.getSnapshot();
    for (const listener of this.listeners) listener(snapshot);
  }

  private pruneExpired(): void {
    const now = this.now();
    for (const [sessionId, grant] of this.grants) {
      if (grant.expiresAt <= now) this.grants.delete(sessionId);
    }
    for (const [id, lease] of this.leases) {
      if (lease.expiresAt <= now) this.leases.delete(id);
    }
  }

  private downgradeAdvancedGrants(): void {
    for (const [sessionId, grant] of this.grants) {
      if (grant.permission === "advanced") this.grants.set(sessionId, { ...grant, permission: "interact" });
    }
  }
}

export function createDisabledAdvancedRuntimePolicy(): BrowserAdvancedRuntimePolicy {
  return {
    enabled: false,
    removeSiteSecurityHeaders: false,
    disableWebSecurity: false,
    allowInsecureContent: false,
    certificateBypassDomains: [],
    unrestrictedRawCdp: false,
  };
}

function validateSessionId(sessionId: string): string {
  const normalized = sessionId.trim();
  if (!normalized || normalized.length > 256 || /[\0\r\n]/.test(normalized)) {
    throw new BrowserError("INVALID_BROWSER_REQUEST", "Browser sessionId is invalid");
  }
  return normalized;
}
