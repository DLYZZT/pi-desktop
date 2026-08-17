import { execFile, spawn } from "node:child_process";
import { findPackageJSON } from "node:module";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

import type { SessionTuiFocusRequest, SessionTuiSpawnRequest } from "./session-tui.ts";

export function parseAliveSessionIds(processText: string): string[] {
  const sessionIds = [...processText.matchAll(/--session(?:=|\s+)(?:"([^"]+)"|(\S+))/g)].flatMap((match) => {
    const sessionArgument = match[1] || match[2];
    if (!sessionArgument) return [];
    const idFromPath = sessionArgument.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i)?.[0];
    return [idFromPath || sessionArgument];
  });
  return [...new Set(sessionIds)];
}

export function sessionTuiWindowName(sessionId: string): string {
  return `pi-${sessionId}`;
}

export function sessionTuiWindowTitle(sessionId: string): string {
  return `π · ${sessionId.slice(0, 8)}`;
}

export function sessionTuiSpawnArgs(request: SessionTuiSpawnRequest): string[] {
  return [
    "-w",
    sessionTuiWindowName(request.sessionId),
    "new-tab",
    "--title",
    sessionTuiWindowTitle(request.sessionId),
    "--suppressApplicationTitle",
    "-d",
    request.cwd,
    "--",
    request.nodeExecutable,
    request.program,
    ...request.args,
  ];
}

export function sessionTuiFocusArgs(request: SessionTuiFocusRequest): string[] {
  return ["-w", sessionTuiWindowName(request.sessionId), "focus-tab", "--target", "0"];
}

export function bundledPiCliPath(): string {
  const packageJsonPath = findPackageJSON(
    "@earendil-works/pi-coding-agent",
    typeof __filename === "string" ? __filename : import.meta.url,
  );
  if (!packageJsonPath) throw new Error("Bundled pi package not found");
  return join(dirname(packageJsonPath), "dist", "cli.js");
}

export function spawnExternalPi(request: SessionTuiSpawnRequest): void {
  spawn("wt.exe", sessionTuiSpawnArgs(request), {
    detached: true,
    stdio: "ignore",
    windowsHide: false,
  }).unref();
}

export function focusExternalPi(request: SessionTuiFocusRequest): void {
  spawn("wt.exe", sessionTuiFocusArgs(request), {
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

const execFileAsync = promisify(execFile);
let aliveSessionLookup: Promise<string[] | null> | null = null;

export function listAliveSessionTuiIds(): Promise<string[] | null> {
  if (aliveSessionLookup) return aliveSessionLookup;
  aliveSessionLookup = execFileAsync("wmic", ["process", "where", "Name='node.exe'", "get", "CommandLine"], {
    encoding: "utf8",
    windowsHide: true,
    timeout: 2000,
  })
    .then(({ stdout }) => parseAliveSessionIds(String(stdout)))
    .catch(() => null)
    .finally(() => {
      aliveSessionLookup = null;
    });
  return aliveSessionLookup;
}
