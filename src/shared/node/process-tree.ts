import { execFile, spawn, type ChildProcess } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";

const POLL_INTERVAL_MS = 20;
const execFileAsync = promisify(execFile);

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function processGroupExists(processGroupId: number): boolean {
  try {
    process.kill(-processGroupId, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

export async function waitForProcessGroupExit(processGroupId: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (processGroupExists(processGroupId)) {
    if (Date.now() >= deadline) return false;
    await wait(Math.min(POLL_INTERVAL_MS, Math.max(1, deadline - Date.now())));
  }
  return true;
}

export function signalPosixProcessGroup(processGroupId: number, signal: NodeJS.Signals): boolean {
  if (!Number.isSafeInteger(processGroupId) || processGroupId <= 1 || process.platform === "win32") return false;
  try {
    process.kill(-processGroupId, signal);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ESRCH";
  }
}

export function parseLinuxProcessStatStartTime(value: string): string | null {
  // /proc/<pid>/stat wraps comm in parentheses; comm itself may contain spaces
  // or closing parentheses, so only the final ") " safely delimits field 2.
  const commandEnd = value.lastIndexOf(") ");
  if (commandEnd < 0) return null;
  const fieldsFromState = value
    .slice(commandEnd + 2)
    .trim()
    .split(/\s+/u);
  const startTime = fieldsFromState[19]; // field 22; the first token here is field 3 (state)
  return startTime && /^\d+$/u.test(startTime) ? startTime : null;
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

export async function getProcessStartFingerprint(processId: number): Promise<string | null> {
  if (!Number.isSafeInteger(processId) || processId <= 1 || process.platform === "win32") return null;
  if (process.platform === "linux") {
    try {
      const [stat, bootIdValue] = await Promise.all([
        readFile(`/proc/${processId}/stat`, "utf8"),
        readFile("/proc/sys/kernel/random/boot_id", "utf8"),
      ]);
      const startTime = parseLinuxProcessStatStartTime(stat);
      const bootId = bootIdValue.trim().toLowerCase();
      if (!startTime || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u.test(bootId)) {
        return null;
      }
      return `linux:${bootId}:${startTime}`;
    } catch {
      return null;
    }
  }
  try {
    const { stdout } = await execFileAsync("ps", ["-o", "lstart=", "-p", String(processId)], {
      encoding: "utf8",
      timeout: 2_000,
      maxBuffer: 16 * 1024,
    });
    const value = stdout.trim().replace(/\s+/g, " ");
    return value || null;
  } catch {
    return null;
  }
}

export async function terminatePosixProcessGroup(
  processGroupId: number,
  options: { interruptMs?: number; terminateMs?: number; forceMs?: number; forceOnly?: boolean } = {},
): Promise<boolean> {
  if (process.platform === "win32" || !Number.isSafeInteger(processGroupId) || processGroupId <= 1) return false;
  if (!processGroupExists(processGroupId)) return true;
  if (!options.forceOnly) {
    signalPosixProcessGroup(processGroupId, "SIGINT");
    if (await waitForProcessGroupExit(processGroupId, options.interruptMs ?? 2_000)) return true;
    signalPosixProcessGroup(processGroupId, "SIGTERM");
    if (await waitForProcessGroupExit(processGroupId, options.terminateMs ?? 3_000)) return true;
  }
  signalPosixProcessGroup(processGroupId, "SIGKILL");
  return waitForProcessGroupExit(processGroupId, options.forceMs ?? 1_500);
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
    await taskkill(processId, false);
    if (await waitForChildExit(child, graceMs)) return;
    await taskkill(processId, true);
    await waitForChildExit(child, graceMs);
    return;
  }

  signalPosixProcessTree(child, "SIGTERM");
  if (await waitForProcessGroupExit(processId, graceMs)) return;
  signalPosixProcessTree(child, "SIGKILL");
  await waitForProcessGroupExit(processId, graceMs);
}
