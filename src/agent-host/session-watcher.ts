/**
 * Watch ~/.pi/agent session directory and push sessions.changed events.
 */
import fs from "fs";
import path from "path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { RpcServer } from "../contract/rpc";

export function startSessionWatcher(server: RpcServer): () => void {
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

  let timer: ReturnType<typeof setTimeout> | null = null;
  const debounce = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      server.emit("sessions.changed", "*", { cwd: null });
    }, 300);
  };

  let watcher: fs.FSWatcher | null = null;
  try {
    watcher = fs.watch(agentDir, { recursive: true }, (_event, filename) => {
      if (!filename) {
        debounce();
        return;
      }
      const name = filename.toString();
      // Session files are typically .jsonl under sessions/ or similar
      if (name.endsWith(".jsonl") || name.endsWith(".json") || name.includes("session")) {
        debounce();
      }
    });
  } catch (err) {
    console.error("[agent-host] session watcher failed:", err);
  }

  return () => {
    if (timer) clearTimeout(timer);
    watcher?.close();
  };
}

export function agentSessionsPath(): string {
  return path.join(getAgentDir());
}
