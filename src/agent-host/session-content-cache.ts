import { statSync } from "node:fs";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import type { SessionEntry } from "../shared/types";

const MAX_CACHED_SESSIONS = 2;
const MAX_CACHED_FILE_BYTES = 128 * 1024 * 1024;

interface Fingerprint {
  size: number;
  mtimeMs: number;
  ctimeMs: number;
  ino: number;
}

export interface SessionContentSnapshot {
  manager: SessionManager;
  entries: SessionEntry[];
  fingerprint: Fingerprint;
}

interface CacheRecord extends SessionContentSnapshot {
  filePath: string;
}

const cache = new Map<string, CacheRecord>();
let cachedFileBytes = 0;

function fingerprint(filePath: string): Fingerprint {
  const stat = statSync(filePath);
  return { size: stat.size, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs, ino: stat.ino };
}

function fingerprintsEqual(left: Fingerprint, right: Fingerprint): boolean {
  return (
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs &&
    left.ino === right.ino
  );
}

function removeRecord(filePath: string): void {
  const existing = cache.get(filePath);
  if (!existing) return;
  cachedFileBytes -= existing.fingerprint.size;
  cache.delete(filePath);
}

function evictIfNeeded(): void {
  while (cache.size > MAX_CACHED_SESSIONS || cachedFileBytes > MAX_CACHED_FILE_BYTES) {
    const oldest = cache.keys().next().value as string | undefined;
    if (!oldest) break;
    removeRecord(oldest);
  }
}

export function getSessionContentSnapshot(filePath: string): SessionContentSnapshot {
  const currentFingerprint = fingerprint(filePath);
  const existing = cache.get(filePath);
  if (existing && fingerprintsEqual(existing.fingerprint, currentFingerprint)) {
    cache.delete(filePath);
    cache.set(filePath, existing);
    return existing;
  }
  removeRecord(filePath);

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const before = fingerprint(filePath);
    const manager = SessionManager.open(filePath);
    const entries = manager.getEntries() as unknown as SessionEntry[];
    const after = fingerprint(filePath);
    if (!fingerprintsEqual(before, after)) {
      if (attempt === 0) continue;
      throw new Error("Session changed while it was being read");
    }
    const record: CacheRecord = { filePath, manager, entries, fingerprint: after };
    cache.set(filePath, record);
    cachedFileBytes += after.size;
    evictIfNeeded();
    return record;
  }
  throw new Error("Unable to read a stable session snapshot");
}

export function invalidateSessionContent(filePath: string): void {
  removeRecord(filePath);
}
