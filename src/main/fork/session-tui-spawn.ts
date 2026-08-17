import { execFileSync, spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { SessionTuiFocusRequest, SessionTuiSpawnRequest } from "./session-tui.ts";

export function parseAliveSessionIds(processText: string): string[] {
  return [...new Set([...processText.matchAll(/--session\s+(\S+)/g)].map((match) => match[1]))];
}

export function sessionTuiWindowName(sessionId: string): string {
  return `pi-${sessionId}`;
}

export function bundledPiCliPath(): string {
  return join(dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"))), "cli.js");
}

export function spawnExternalPi(request: SessionTuiSpawnRequest, electronExecPath: string): void {
  const command = `set ELECTRON_RUN_AS_NODE=1&& "${electronExecPath}" "${request.program}" ${request.args.join(" ")}`;
  spawn("wt.exe", ["-w", sessionTuiWindowName(request.sessionId), "-d", request.cwd, "--", "cmd.exe", "/c", command], {
    detached: true,
    stdio: "ignore",
    windowsHide: false,
  }).unref();
}

export function focusExternalPi(request: SessionTuiFocusRequest): void {
  spawn("wt.exe", ["-w", sessionTuiWindowName(request.sessionId)], {
    detached: true,
    stdio: "ignore",
    windowsHide: false,
  }).unref();
}

export function killExternalPiSessions(sessionIds: string[]): void {
  for (const sessionId of sessionIds) {
    spawn("wmic", ["process", "where", `CommandLine like '%--session ${sessionId}%'`, "call", "terminate"], {
      shell: false,
      windowsHide: true,
      stdio: "ignore",
    }).on("error", () => undefined);
  }
}

export function listAliveSessionTuiIds(): string[] | null {
  try {
    const text = execFileSync("wmic", ["process", "get", "CommandLine"], {
      encoding: "utf8",
      windowsHide: true,
      timeout: 2000,
    });
    return parseAliveSessionIds(text);
  } catch {
    return null;
  }
}
