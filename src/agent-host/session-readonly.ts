import { closeSync, constants, fstatSync, openSync, readSync, accessSync } from "node:fs";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";
import { CURRENT_SESSION_VERSION, parseSessionEntries, SessionManager } from "@earendil-works/pi-coding-agent";
import { RpcError } from "../contract/types.ts";

const READ_BUFFER_BYTES = 64 * 1024;

/** Read a JSONL snapshot without repairing, creating, or migrating its source file. */
export function readSessionSnapshot(filePath: string): SessionManager {
  const fd = openSync(filePath, "r");
  const entries: ReturnType<typeof parseSessionEntries> = [];
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
      pending += decoder.write(buffer.subarray(0, count));
      const end = pending.lastIndexOf("\n");
      if (end >= 0) {
        for (const entry of parseSessionEntries(pending.slice(0, end))) entries.push(entry);
        pending = pending.slice(end + 1);
      }
    }
    pending += decoder.end();
    for (const entry of parseSessionEntries(pending)) entries.push(entry);
    const after = fstatSync(fd);
    if (position !== initial.size || after.size !== initial.size || after.mtimeMs !== initial.mtimeMs) {
      throw new Error("Session changed while it was being read");
    }
  } finally {
    closeSync(fd);
  }
  const header = entries[0];
  if (!header || header.type !== "session" || typeof header.id !== "string" || !header.id) {
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
