import { randomUUID } from "node:crypto";
import { renameSync } from "node:fs";
import { mkdir, readFile, open, rm } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import lockfile from "proper-lockfile";

export type JsonRecord = Record<string, unknown>;

export function parseJsonRecord(text: string): JsonRecord {
  let value: unknown;
  try {
    value = JSON.parse(text.replace(/^\uFEFF/u, ""));
  } catch {
    throw new Error("Configuration contains invalid JSON");
  }
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Configuration must contain a JSON object");
  return value as JsonRecord;
}

/**
 * Uses the same <file>.lock protocol and realpath:false policy as Pi 0.99.1.
 * `text` is the raw content `current` was parsed from (null when missing). `beforeCommit` runs synchronously
 * immediately before the rename, so callers can reject writers that ignore the lock (e.g. external editors).
 */
export async function withLockedJsonFile<T>(
  filename: string,
  action: (
    current: JsonRecord,
    save: (next: JsonRecord, beforeCommit?: () => void) => Promise<void>,
    text: string | null,
  ) => Promise<T>,
  signal?: AbortSignal,
  options: { allowEmpty?: boolean } = {},
): Promise<T> {
  await mkdir(path.dirname(filename), { recursive: true, mode: 0o700 });
  let compromised: Error | undefined;
  let committed = false;
  let release: (() => Promise<void>) | undefined;
  const deadline = Date.now() + 30_000;
  while (!release) {
    signal?.throwIfAborted();
    try {
      release = await lockfile.lock(filename, {
        realpath: false,
        stale: 30_000,
        retries: 0,
        onCompromised(error) {
          compromised = error;
        },
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ELOCKED" || Date.now() >= deadline) throw error;
      await delay(20, undefined, { signal });
    }
  }
  const assertOwned = () => {
    if (!committed) signal?.throwIfAborted();
    if (compromised) throw compromised;
  };
  try {
    assertOwned();
    let current: JsonRecord;
    let text: string | null = null;
    try {
      text = await readFile(filename, "utf8");
      current = options.allowEmpty && !text.trim() ? {} : parseJsonRecord(text);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      current = {};
    }
    const save = async (next: JsonRecord, beforeCommit?: () => void) => {
      assertOwned();
      const temporary = `${filename}.${process.pid}.${randomUUID()}.tmp`;
      try {
        const handle = await open(temporary, "wx", 0o600);
        try {
          await handle.writeFile(JSON.stringify(next, null, 2) + "\n", "utf8");
          await handle.sync();
        } finally {
          await handle.close();
        }
        assertOwned();
        // Keep the final cancellation/content checks and commit in one event-loop step.
        beforeCommit?.();
        renameSync(temporary, filename);
        committed = true;
      } finally {
        await rm(temporary, { force: true });
      }
    };
    const result = await action(current, save, text);
    assertOwned();
    return result;
  } finally {
    await release();
  }
}
