/**
 * Watch ~/.pi/agent session directory and push sessions.changed events.
 */
import fs from "fs";
import path from "path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { RpcServer } from "../contract/rpc";
import { invalidateAllowedRootsCache, setAllowedRootsWatcherHealthy } from "./file-access";
import { sessionIndex } from "./session-index";
import { classifySessionWatchChange } from "./session-watch-policy";

export interface SessionWatcherOptions {
  index?: Pick<typeof sessionIndex, "getByPath" | "refreshPath" | "refreshAll">;
  watch?: (
    directory: string,
    onChange: (event: fs.WatchEventType, filename: string | Buffer | null) => void,
  ) => { on(event: "error", listener: (error: Error) => void): unknown; close(): void };
  schedule?: (flush: () => Promise<void>) => () => void;
}

function scheduleRefresh(flush: () => Promise<void>): () => void {
  const timer = setTimeout(() => void flush(), 300);
  return () => clearTimeout(timer);
}

export function startSessionWatcher(server: RpcServer, options: SessionWatcherOptions = {}): () => void {
  const index = options.index ?? sessionIndex;
  const schedule = options.schedule ?? scheduleRefresh;
  const watch = options.watch ?? ((directory, onChange) => fs.watch(directory, { recursive: true }, onChange));
  let agentDir: string;
  try {
    agentDir = getAgentDir();
  } catch {
    return () => {};
  }

  if (!fs.existsSync(agentDir)) {
    try {
      fs.mkdirSync(agentDir, { recursive: true });
    } catch {
      return () => {};
    }
  }

  const sessionsRoot = path.resolve(process.env.PI_CODING_AGENT_SESSION_DIR || path.join(agentDir, "sessions"));
  const changedPaths = new Set<string>();
  let fullRefreshRequired = false;
  let cancelTimer: (() => void) | null = null;
  let stopped = false;
  let flushing = false;

  const schedulePending = () => {
    if (stopped || flushing) return;
    cancelTimer?.();
    cancelTimer = schedule(async () => {
      cancelTimer = null;
      if (stopped) return;
      flushing = true;
      try {
        invalidateAllowedRootsCache();
        const pendingPaths = [...changedPaths];
        changedPaths.clear();
        const shouldRefreshAll = fullRefreshRequired;
        fullRefreshRequired = false;
        if (shouldRefreshAll) {
          await index.refreshAll();
          if (stopped) return;
          server.emit("sessions.changed", "*", { cwd: null, fullRefresh: true });
          return;
        }
        for (const filePath of pendingPaths) {
          const previous = index.getByPath(filePath);
          const session = await index.refreshPath(filePath);
          if (stopped) return;
          if (session) {
            server.emit("sessions.changed", session.id, { cwd: session.cwd, sessionId: session.id, session });
          } else if (previous) {
            server.emit("sessions.changed", previous.id, {
              cwd: previous.cwd,
              sessionId: previous.id,
              deleted: true,
            });
          } else {
            server.emit("sessions.changed", "*", { cwd: null, fullRefresh: true });
          }
        }
      } catch (error) {
        if (stopped) return;
        console.error("[agent-host] session watcher refresh failed:", error);
        server.emit("sessions.changed", "*", { cwd: null, fullRefresh: true });
      } finally {
        flushing = false;
        // Events received during an asynchronous scan belong to the next scan.
        if (fullRefreshRequired || changedPaths.size > 0) schedulePending();
      }
    });
  };
  const debounce = (changedPath?: string) => {
    if (stopped) return;
    if (changedPath) changedPaths.add(changedPath);
    else fullRefreshRequired = true;
    schedulePending();
  };

  let watcher: ReturnType<NonNullable<SessionWatcherOptions["watch"]>> | null = null;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    cancelTimer?.();
    cancelTimer = null;
    changedPaths.clear();
    fullRefreshRequired = false;
    watcher?.close();
    setAllowedRootsWatcherHealthy(false);
    invalidateAllowedRootsCache();
  };
  try {
    watcher = watch(agentDir, (_event, filename) => {
      if (stopped) return;
      const change = classifySessionWatchChange(agentDir, sessionsRoot, filename);
      if (change.kind === "refresh-path") debounce(change.path);
      else if (change.kind === "refresh-all") debounce();
    });
    watcher.on("error", (err) => {
      if (stopped) return;
      console.error("[agent-host] session watcher error:", err);
      stop();
    });
    setAllowedRootsWatcherHealthy(true);
  } catch (err) {
    stop();
    console.error("[agent-host] session watcher failed:", err);
  }

  return stop;
}

export function agentSessionsPath(): string {
  return path.join(getAgentDir());
}
