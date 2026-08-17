import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { SessionTuiSpawnRequest } from "./session-tui.ts";

export function bundledPiCliPath(): string {
  return join(dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"))), "cli.js");
}

export function spawnExternalPi(request: SessionTuiSpawnRequest, electronExecPath: string): void {
  const command = `set ELECTRON_RUN_AS_NODE=1&& "${electronExecPath}" "${request.program}" ${request.args.join(" ")}`;
  spawn("wt.exe", ["-d", request.cwd, "--", "cmd.exe", "/c", command], {
    detached: true,
    stdio: "ignore",
    windowsHide: false,
  }).unref();
}
