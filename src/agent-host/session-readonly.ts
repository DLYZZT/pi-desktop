import { closeSync, constants, fstatSync, openSync, readSync, accessSync } from "node:fs";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";
import { CURRENT_SESSION_VERSION, parseSessionEntries, SessionManager } from "@earendil-works/pi-coding-agent";
import { RpcError } from "../contract/types.ts";
import { createHash } from "node:crypto";

const READ_BUFFER_BYTES = 64 * 1024;

/** Read just the first JSONL record. The caller supplies a verified session path inside the store. */
export function readSessionFileHeader(filePath: string): { id: string; cwd?: string } | undefined {
  const fd = openSync(filePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) return;
    const limit = Math.min(stat.size, 1024 * 1024);
    const buffer = Buffer.allocUnsafe(4096),
      decoder = new StringDecoder("utf8");
    let pending = "";
    for (let offset = 0; offset < limit;) {
      const count = readSync(fd, buffer, 0, Math.min(buffer.length, limit - offset), offset);
      if (!count) break;
      offset += count;
      const lines = (pending + decoder.write(buffer.subarray(0, count))).split("\n");
      pending = lines.pop()!;
      if (offset === stat.size) lines.push(pending + decoder.end());
      const record = lines.find((line) => line.trim());
      if (!record) continue;
      try {
        const header = JSON.parse(record.trim());
        if (header?.type === "session" && typeof header.id === "string")
          return {
            id: header.id,
            cwd: typeof header.cwd === "string" && path.isAbsolute(header.cwd) ? header.cwd : undefined,
          };
      } catch {
        /* A malformed record cannot identify a session. */
      }
      return;
    }
    if (stat.size > limit)
      throw Object.assign(new Error("Session header exceeds the discovery limit"), { code: "SESSION_HEADER_LIMIT" });
  } finally {
    closeSync(fd);
  }
}

function invalidRecord(line: number): RpcError {
  return new RpcError({
    code: "SESSION_FORK_INVALID_HISTORY",
    detail: { line },
    message:
      "The session contains a damaged JSONL record. Restore the session file from a backup or start a new session.",
  });
}

/** Read a JSONL snapshot without repairing, creating, or migrating its source file. */
export function readSessionSnapshot(
  filePath: string,
  { strictJson = false, confirmedIncompleteTail }: { strictJson?: boolean; confirmedIncompleteTail?: string } = {},
): SessionManager {
  const fd = openSync(filePath, "r");
  const entries: ReturnType<typeof parseSessionEntries> = [];
  let lineNumber = 0;
  const integrity: { damagedLine?: number; hash?: ReturnType<typeof createHash> } = strictJson
    ? { hash: createHash("sha256").update(filePath).update("\0") }
    : {};
  const appendEntries = (text: string) => {
    if (!strictJson) {
      for (const entry of parseSessionEntries(text)) entries.push(entry);
      return;
    }
    for (const line of text.split("\n")) {
      lineNumber++;
      const record = line.trim();
      if (!record) continue;
      if (integrity.damagedLine !== undefined) throw invalidRecord(integrity.damagedLine);
      try {
        entries.push(JSON.parse(record));
      } catch {
        integrity.damagedLine = lineNumber;
      }
    }
  };
  try {
    const initial = fstatSync(fd);
    if (!initial.isFile()) throw new Error("Session source must be a regular file");
    const decoder = new StringDecoder("utf8");
    const buffer = Buffer.allocUnsafe(READ_BUFFER_BYTES);
    let pending = "";
    let position = 0;
    // Bound reads to the initial size; a concurrently growing log cannot keep us reading forever.
    while (position < initial.size) {
      const count = readSync(fd, buffer, 0, Math.min(buffer.length, initial.size - position), position);
      if (!count) break;
      position += count;
      const bytes = buffer.subarray(0, count);
      integrity.hash?.update(bytes);
      pending += decoder.write(bytes);
      const end = pending.lastIndexOf("\n");
      if (end >= 0) {
        appendEntries(pending.slice(0, end));
        pending = pending.slice(end + 1);
      }
    }
    pending += decoder.end();
    appendEntries(pending);
    const after = fstatSync(fd);
    if (
      position !== initial.size ||
      after.size !== initial.size ||
      after.mtimeMs !== initial.mtimeMs ||
      after.ctimeMs !== initial.ctimeMs
    ) {
      throw new Error("Session changed while it was being read");
    }
  } finally {
    closeSync(fd);
  }
  const header = entries[0];
  if (!header || header.type !== "session" || typeof header.id !== "string" || !header.id) {
    if (strictJson) throw invalidRecord(1);
    throw new Error("Session file has no valid header");
  }
  if (
    header.version !== undefined &&
    (!Number.isInteger(header.version) || header.version > CURRENT_SESSION_VERSION || header.version < 1)
  ) {
    throw new Error("Unsupported session version");
  }
  if (entries.slice(1).some((entry) => !entry || typeof entry !== "object" || entry.type === "session")) {
    throw new Error("Session file contains an invalid entry or duplicate header");
  }
  if (integrity.damagedLine !== undefined && integrity.hash) {
    const revision = integrity.hash.digest("hex");
    if (confirmedIncompleteTail !== revision)
      throw new RpcError({
        code: "SESSION_FORK_INCOMPLETE_TAIL",
        detail: { line: integrity.damagedLine, revision },
        message: "The final session record is incomplete. You may create a copy using the complete records.",
      });
  } else if (strictJson && confirmedIncompleteTail !== undefined) {
    throw new RpcError({
      code: "SESSION_FORK_SOURCE_CHANGED",
      message: "The source history has changed. Choose the folder again to copy the current history.",
    });
  }
  return SessionManager.inMemory(
    typeof header.cwd === "string" && header.cwd ? header.cwd : path.dirname(filePath),
    undefined,
    entries,
  );
}

/** This probe never alters permissions or repairs JSONL; the actual writer still handles races. */
export function assertSessionWritable(filePath: string): void {
  try {
    accessSync(filePath, constants.W_OK);
    const fd = openSync(filePath, "r+");
    closeSync(fd);
  } catch (error) {
    if (["EACCES", "EPERM", "EROFS"].includes((error as NodeJS.ErrnoException).code ?? "")) {
      throw new RpcError({
        code: "FORBIDDEN",
        message: "Session is read-only; history remains available, but changes cannot be saved",
      });
    }
    throw error;
  }
}
