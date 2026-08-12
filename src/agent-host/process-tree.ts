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
