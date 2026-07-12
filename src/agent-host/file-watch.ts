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
  timer: ReturnType<typeof setTimeout> | null;
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

      if (!fs.existsSync(filePath)) {
        throw new RpcError({ code: "NOT_FOUND", message: "Path not found" });
      }
      const initialStats = fs.statSync(filePath);
      if (!initialStats.isFile() && !initialStats.isDirectory()) {
        throw new RpcError({ code: "BAD_REQUEST", message: "Path is not watchable" });
      }

      let watcher: fs.FSWatcher;
      let watchEntry: WatchEntry | null = null;
      const emitChange = () => {
        if (watchEntry?.timer) clearTimeout(watchEntry.timer);
        const timer = setTimeout(() => {
          if (watchEntry) watchEntry.timer = null;
          try {
            const s = fs.statSync(filePath);
            server.emit("files.changed", filePath, {
              path: filePath,
              event: "change",
              mtime: s.mtime.toISOString(),
              ...(s.isFile() ? { size: s.size } : {}),
            });
          } catch {
            server.emit("files.changed", filePath, {
              path: filePath,
              event: "change",
              mtime: new Date().toISOString(),
            });
          }
        }, 100);
        if (watchEntry) watchEntry.timer = timer;
      };
      try {
        watcher = initialStats.isDirectory()
          ? fs.watch(filePath, { recursive: true }, emitChange)
          : fs.watch(filePath, emitChange);
      } catch (err) {
        // Recursive watching is not supported by every Node/platform pair.
        if (initialStats.isDirectory()) {
          try {
            watcher = fs.watch(filePath, emitChange);
          } catch (fallbackError) {
            throw new RpcError({
              code: "INTERNAL",
              message: fallbackError instanceof Error ? fallbackError.message : "Failed to watch directory",
            });
          }
        } else {
          throw new RpcError({
            code: "INTERNAL",
            message: err instanceof Error ? err.message : "Failed to watch file",
          });
        }
      }

      watcher.on("error", () => {
        server.emit("files.changed", filePath, {
          path: filePath,
          event: "error",
          message: "Watch error",
        });
        stop(filePath, true);
      });

      watchEntry = { watcher, refs: 1, timer: null };
      watches.set(filePath, watchEntry);
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
  if (entry.timer) clearTimeout(entry.timer);
  watches.delete(filePath);
}

export function stopAllFileWatches(): void {
  for (const [path] of watches) stop(path, true);
}
