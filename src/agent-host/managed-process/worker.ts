import { spawn, type ChildProcess } from "node:child_process";
import type {
  ManagedProcessWorkerBootstrap,
  ManagedProcessWorkerEvent,
  ManagedProcessWorkerRequest,
} from "./protocol.ts";

let child: ChildProcess | null = null;
let bootstrapped = false;
let stopping = false;
let exiting = false;
let stopSource: "agent" | "user" | "host" | "main" = "host";

function send(event: ManagedProcessWorkerEvent): void {
  if (!process.connected) return;
  try {
    process.send?.(event);
  } catch {
    /* parent disappeared */
  }
}

function safeError(error: unknown): string {
  const code = (error as NodeJS.ErrnoException)?.code;
  return code ? `Managed shell error (${code})` : "Managed shell error";
}

function groupSignal(signal: NodeJS.Signals): void {
  if (process.platform === "win32") return;
  try {
    process.kill(-process.pid, signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH")
      send({ type: "error", code: "SIGNAL_FAILED", message: "Could not signal managed process group" });
  }
}

function waitForChild(timeoutMs: number): Promise<boolean> {
  const current = child;
  if (!current || current.exitCode !== null || current.signalCode !== null) return Promise.resolve(true);
  return new Promise((resolve) => {
    const finish = (value: boolean) => {
      clearTimeout(timer);
      current.removeListener("close", onClose);
      resolve(value);
    };
    const onClose = () => finish(true);
    const timer = setTimeout(() => finish(false), timeoutMs);
    timer.unref();
    current.once("close", onClose);
  });
}

async function stop(mode: "graceful" | "force", source: typeof stopSource): Promise<void> {
  if (stopping) return;
  stopping = true;
  stopSource = source;
  if (!child) {
    process.exit(0);
    return;
  }
  if (mode !== "force") {
    send({ type: "stopping", phase: "interrupt" });
    groupSignal("SIGINT");
    if (await waitForChild(2_000)) return;
    send({ type: "stopping", phase: "terminate" });
    groupSignal("SIGTERM");
    if (await waitForChild(3_000)) return;
  }
  send({ type: "stopping", phase: "force" });
  groupSignal("SIGKILL");
  setTimeout(() => process.exit(1), 1_500).unref();
}

function validBootstrap(value: ManagedProcessWorkerBootstrap): boolean {
  return Boolean(
    value &&
    value.type === "bootstrap" &&
    typeof value.processId === "string" &&
    typeof value.runId === "string" &&
    typeof value.cwd === "string" &&
    typeof value.command === "string" &&
    value.shell &&
    typeof value.shell.executable === "string" &&
    Array.isArray(value.shell.argvPrefix) &&
    value.shell.argvPrefix.every((argument) => typeof argument === "string"),
  );
}

function start(input: ManagedProcessWorkerBootstrap): void {
  if (bootstrapped || !validBootstrap(input)) {
    send({ type: "error", code: "INVALID_BOOTSTRAP", message: "Invalid managed process bootstrap" });
    process.exit(2);
    return;
  }
  bootstrapped = true;
  const childEnvironment = { ...process.env };
  delete childEnvironment.ELECTRON_RUN_AS_NODE;
  try {
    child = spawn(input.shell.executable, [...input.shell.argvPrefix, "-c", input.command], {
      cwd: input.cwd,
      env: childEnvironment,
      shell: false,
      detached: false,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
  } catch (error) {
    send({ type: "error", code: "SPAWN_FAILED", message: safeError(error) });
    process.exit(2);
    return;
  }

  child.stdout?.pipe(process.stdout);
  child.stderr?.pipe(process.stderr);
  child.once("spawn", () => send({ type: "started", shellPid: child?.pid ?? 0 }));
  child.once("error", (error) => send({ type: "error", code: "SPAWN_FAILED", message: safeError(error) }));
  child.once("close", (code, signal) => {
    if (exiting) return;
    exiting = true;
    send({ type: "exit", code, ...(signal ? { signal } : {}) });
    // A root shell that exits must not leave an internally-backgrounded descendant.
    if (!stopping) groupSignal("SIGTERM");
    setTimeout(() => process.exit(stopping && stopSource !== "host" ? 0 : (code ?? 1)), 25).unref();
  });
}

process.on("message", (value: unknown) => {
  const message = value as ManagedProcessWorkerRequest;
  if (message?.type === "bootstrap") {
    start(message);
    return;
  }
  if (!bootstrapped || !child) return;
  if (message?.type === "stdin") {
    if (!child.stdin || child.stdin.destroyed || child.stdin.writableEnded) {
      send({ type: "stdin-closed" });
      return;
    }
    if (message.text) child.stdin.write(message.appendNewline ? `${message.text}\n` : message.text);
    else if (message.appendNewline) child.stdin.write("\n");
    if (message.close) {
      child.stdin.end();
      send({ type: "stdin-closed" });
    }
    return;
  }
  if (message?.type === "stop") void stop(message.mode, message.source);
});

process.on("disconnect", () => {
  void stop("graceful", "host");
});
process.on("SIGINT", () => {
  if (!stopping) void stop("graceful", "host");
});
process.on("SIGTERM", () => {
  if (!stopping) void stop("graceful", "host");
});

setTimeout(() => {
  if (bootstrapped) return;
  send({ type: "error", code: "BOOTSTRAP_TIMEOUT", message: "Managed process bootstrap timed out" });
  process.exit(2);
}, 10_000).unref();
