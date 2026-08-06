import fs from "node:fs";
import path from "node:path";
import type { BrowserPersistentSessionGrant, BrowserPersistentSessionPermission } from "../../contract/browser.ts";
import { BrowserError } from "./browser-error.ts";

const STORE_VERSION = 1 as const;
const MAX_STORE_BYTES = 1024 * 1024;
const MAX_GRANTS = 10_000;

type GrantFile = {
  version: typeof STORE_VERSION;
  grants: BrowserPersistentSessionGrant[];
};

export class BrowserPersistentGrantStore {
  private loaded = false;
  private readonly grants = new Map<string, BrowserPersistentSessionGrant>();
  private readonly filePath: string;

  constructor(filePath: string) {
    this.filePath = filePath;
  }

  get(sessionId: string): BrowserPersistentSessionGrant | undefined {
    this.ensureLoaded();
    const grant = this.grants.get(validateSessionId(sessionId));
    return grant ? structuredClone(grant) : undefined;
  }

  list(): BrowserPersistentSessionGrant[] {
    this.ensureLoaded();
    return [...this.grants.values()]
      .sort((left, right) => left.sessionId.localeCompare(right.sessionId))
      .map((grant) => structuredClone(grant));
  }

  set(sessionId: string, permission: BrowserPersistentSessionPermission): BrowserPersistentSessionGrant | undefined {
    this.ensureLoaded();
    const normalized = validateSessionId(sessionId);
    if (permission === "inherit") {
      if (this.grants.delete(normalized)) this.persist();
      return undefined;
    }
    if (!["ask", "deny", "read", "interact", "advanced"].includes(permission)) {
      throw new BrowserError("INVALID_BROWSER_REQUEST", "Persistent Browser permission is invalid");
    }
    const grant: BrowserPersistentSessionGrant = {
      sessionId: normalized,
      permission,
      source: "settings",
      updatedAt: Date.now(),
    };
    this.grants.set(normalized, grant);
    this.persist();
    return structuredClone(grant);
  }

  delete(sessionId: string): void {
    this.set(sessionId, "inherit");
  }

  gc(activeSessionIds: Iterable<string>): void {
    this.ensureLoaded();
    const active = new Set([...activeSessionIds].map(validateSessionId));
    let changed = false;
    for (const sessionId of this.grants.keys()) {
      if (!active.has(sessionId)) {
        this.grants.delete(sessionId);
        changed = true;
      }
    }
    if (changed) this.persist();
  }

  clear(): void {
    this.loaded = true;
    this.grants.clear();
    try {
      fs.rmSync(this.filePath, { force: true });
    } catch {
      // The empty in-memory store remains authoritative for this process.
    }
  }

  private ensureLoaded(): void {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const stats = fs.statSync(this.filePath);
      if (!stats.isFile() || stats.size > MAX_STORE_BYTES) return;
      const parsed = JSON.parse(fs.readFileSync(this.filePath, "utf8")) as Partial<GrantFile>;
      if (parsed.version !== STORE_VERSION || !Array.isArray(parsed.grants)) return;
      for (const candidate of parsed.grants.slice(0, MAX_GRANTS)) {
        if (!isGrant(candidate)) continue;
        this.grants.set(candidate.sessionId, structuredClone(candidate));
      }
    } catch {
      this.grants.clear();
    }
  }

  private persist(): void {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const temp = `${this.filePath}.${process.pid}.${Date.now()}.tmp`;
    const file: GrantFile = { version: STORE_VERSION, grants: this.list() };
    try {
      fs.writeFileSync(temp, `${JSON.stringify(file, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
      fs.renameSync(temp, this.filePath);
      try {
        fs.chmodSync(this.filePath, 0o600);
      } catch {
        // Windows uses the per-user profile ACL instead of POSIX mode bits.
      }
    } finally {
      try {
        fs.rmSync(temp, { force: true });
      } catch {
        // Best-effort atomic-write cleanup.
      }
    }
  }
}

function validateSessionId(value: string): string {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!normalized || normalized.length > 256 || /[\0\r\n]/.test(normalized)) {
    throw new BrowserError("INVALID_BROWSER_REQUEST", "Browser sessionId is invalid");
  }
  return normalized;
}

function isGrant(value: unknown): value is BrowserPersistentSessionGrant {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const grant = value as Partial<BrowserPersistentSessionGrant>;
  try {
    validateSessionId(grant.sessionId ?? "");
  } catch {
    return false;
  }
  return (
    ["ask", "deny", "read", "interact", "advanced"].includes(grant.permission ?? "") &&
    grant.source === "settings" &&
    Number.isFinite(grant.updatedAt) &&
    (grant.updatedAt ?? 0) > 0
  );
}
