import { spawn, type ChildProcess } from "node:child_process";

const POLL_INTERVAL_MS = 20;

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function processGroupExists(processGroupId: number): boolean {
  try {
    process.kill(-processGroupId, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

async function waitForProcessGroupExit(processGroupId: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (processGroupExists(processGroupId)) {
    if (Date.now() >= deadline) return false;
    await wait(Math.min(POLL_INTERVAL_MS, Math.max(1, deadline - Date.now())));
  }
  return true;
}

function signalPosixProcessTree(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.pid) {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") return;
    }
  }
  try {
    child.kill(signal);
  } catch {
    /* process already exited */
  }
}

function waitForChildExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return new Promise((resolve) => {
    const finish = (exited: boolean) => {
      clearTimeout(timer);
      child.removeListener("close", onClose);
      resolve(exited);
    };
    const onClose = () => finish(true);
    const timer = setTimeout(() => finish(false), timeoutMs);
    timer.unref();
    child.once("close", onClose);
  });
}

function taskkill(processId: number, force: boolean): Promise<void> {
  return new Promise((resolve) => {
    const args = ["/PID", String(processId), "/T", ...(force ? ["/F"] : [])];
    let command: ChildProcess;
    try {
      command = spawn("taskkill", args, { shell: false, windowsHide: true, stdio: "ignore" });
    } catch {
      resolve();
      return;
    }
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      resolve();
    };
    command.once("error", finish);
    command.once("close", finish);
  });
}

const COMMAND_PROCESS_NAMES = new Set([
  "bash.exe",
  "sh.exe",
  "ssh.exe",
  "scp.exe",
  "sftp.exe",
  "curl.exe",
  "bash",
  "sh",
  "ssh",
  "scp",
  "sftp",
  "curl",
]);

export function childPidsOf(rootPid: number, rows: Array<{ pid: number; ppid: number; name: string }>): number[] {
  return rows.filter((row) => row.ppid === rootPid && row.pid !== rootPid).map((row) => row.pid);
}

export function commandPidsUnder(rootPid: number, rows: Array<{ pid: number; ppid: number; name: string }>): number[] {
  const children = new Map<number, number[]>();
  const names = new Map<number, string>();
  for (const row of rows) {
    names.set(row.pid, row.name);
    const list = children.get(row.ppid) ?? [];
    list.push(row.pid);
    children.set(row.ppid, list);
  }
  const found: number[] = [];
  const stack = [...(children.get(rootPid) ?? [])];
  while (stack.length > 0) {
    const pid = stack.pop();
    if (pid === undefined || pid === rootPid) continue;
    const name = (names.get(pid) ?? "").toLowerCase();
    if (COMMAND_PROCESS_NAMES.has(name)) found.push(pid);
    const next = children.get(pid);
    if (next) stack.push(...next);
  }
  return found;
}

/** WMIC default table. `/FORMAT:CSV` is broken on this host (Invalid XSL format). */
export function parseWmicTable(text: string): Array<{ pid: number; ppid: number; name: string }> {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.replace(/\s+$/, ""))
    .filter(Boolean);
  if (lines.length < 2) return [];
  const header = lines[0];
  const nameAt = header.indexOf("Name");
  const ppidAt = header.indexOf("ParentProcessId");
  const pidAt = header.indexOf("ProcessId", ppidAt + "ParentProcessId".length);
  if (nameAt < 0 || ppidAt < 0 || pidAt < 0) return [];
  const rows: Array<{ pid: number; ppid: number; name: string }> = [];
  for (const line of lines.slice(1)) {
    const name = line.slice(nameAt, ppidAt).trim();
    const ppid = Number(line.slice(ppidAt, pidAt).trim());
    const pid = Number(line.slice(pidAt).trim());
    if (!name || !Number.isSafeInteger(pid) || !Number.isSafeInteger(ppid)) continue;
    rows.push({ pid, ppid, name });
  }
  return rows;
}

export function terminatePidTree(processId: number): void {
  if (!Number.isSafeInteger(processId) || processId <= 0) return;
  if (process.platform === "win32") {
    spawn("taskkill", ["/PID", String(processId), "/T", "/F"], {
      shell: false,
      windowsHide: true,
      stdio: "ignore",
    }).on("error", () => undefined);
    return;
  }
  try {
    process.kill(-processId, "SIGINT");
  } catch {
    try {
      process.kill(processId, "SIGINT");
    } catch {
      /* already gone */
    }
  }
}

/** Kill every direct child of the Agent Host. `/T` takes ssh hiding under Git-bash. */
export function interruptCommandDescendants(rootPid: number, onPids?: (pids: number[]) => void): void {
  if (!Number.isSafeInteger(rootPid) || rootPid <= 0) return;
  if (process.platform !== "win32") {
    onPids?.([]);
    return;
  }
  const child = spawn("wmic", ["process", "get", "Name,ParentProcessId,ProcessId"], {
    shell: false,
    windowsHide: true,
    stdio: ["ignore", "pipe", "ignore"],
  });
  const chunks: Buffer[] = [];
  child.stdout?.on("data", (chunk: Buffer) => chunks.push(chunk));
  child.on("error", () => onPids?.([]));
  child.on("close", () => {
    const pids = commandPidsUnder(rootPid, parseWmicTable(Buffer.concat(chunks).toString("utf8")));
    for (const pid of pids) terminatePidTree(pid);
    onPids?.(pids);
  });
}

export async function terminateProcessTree(child: ChildProcess, graceMs = 1_000): Promise<void> {
  const processId = child.pid;
  if (!processId) {
    try {
      child.kill();
    } catch {
      /* process never started */
    }
    return;
  }

  if (process.platform === "win32") {
    // Soft WM_CLOSE lets Git-bash exit while SSH/curl children keep running.
    await taskkill(processId, true);
    await waitForChildExit(child, graceMs);
    return;
  }

  signalPosixProcessTree(child, "SIGTERM");
  if (await waitForProcessGroupExit(processId, graceMs)) return;
  signalPosixProcessTree(child, "SIGKILL");
  await waitForProcessGroupExit(processId, graceMs);
}
