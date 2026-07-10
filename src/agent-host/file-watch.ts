/**
 * Per-path fs.watch → Streams["files.changed"].
 */
import fs from "fs";
import type { RpcServer } from "../contract/rpc";
import { getAllowedFileRoots, isFilePathAllowed } from "./file-access";
import { isFilePathReferencedBySession } from "./session-file-references";
import { RpcError } from "../contract/types";

type WatchEntry = {
  watcher: fs.FSWatcher;
  refs: number;
};

const watches = new Map<string, WatchEntry>();

export function createFileWatchService(server: RpcServer) {
  async function assertAllowed(filePath: string, sourceSessionId?: string): Promise<void> {
    const roots = await getAllowedFileRoots();
    if (isFilePathAllowed(filePath, roots)) return;
    if (sourceSessionId && (await isFilePathReferencedBySession(filePath, sourceSessionId))) return;
    throw new RpcError({ code: "FORBIDDEN", message: "Access denied" });
  }

  return {
    async start(filePath: string, sourceSessionId?: string): Promise<void> {
      await assertAllowed(filePath, sourceSessionId);
      const existing = watches.get(filePath);
      if (existing) {
        existing.refs += 1;
        server.emit("files.changed", filePath, {
          path: filePath,
          event: "connected",
        });
        return;
      }

      if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
        throw new RpcError({ code: "NOT_FOUND", message: "Not a file" });
      }

      let watcher: fs.FSWatcher;
      try {
        watcher = fs.watch(filePath, () => {
          try {
            const s = fs.statSync(filePath);
            server.emit("files.changed", filePath, {
              path: filePath,
              event: "change",
              mtime: s.mtime.toISOString(),
              size: s.size,
            });
          } catch {
            server.emit("files.changed", filePath, {
              path: filePath,
              event: "change",
              mtime: new Date().toISOString(),
              size: 0,
            });
          }
        });
      } catch (err) {
        throw new RpcError({
          code: "INTERNAL",
          message: err instanceof Error ? err.message : "Failed to watch file",
        });
      }

      watcher.on("error", () => {
        server.emit("files.changed", filePath, {
          path: filePath,
          event: "error",
          message: "Watch error",
        });
        stop(filePath, true);
      });

      watches.set(filePath, { watcher, refs: 1 });
      server.emit("files.changed", filePath, {
        path: filePath,
        event: "connected",
      });
    },

    stop(filePath: string, force = false): void {
      stop(filePath, force);
    },
  };
}

function stop(filePath: string, force = false): void {
  const entry = watches.get(filePath);
  if (!entry) return;
  entry.refs -= 1;
  if (!force && entry.refs > 0) return;
  try {
    entry.watcher.close();
  } catch {
    /* ignore */
  }
  watches.delete(filePath);
}

export function stopAllFileWatches(): void {
  for (const [path] of watches) stop(path, true);
}
