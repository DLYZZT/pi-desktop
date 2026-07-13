import { randomUUID } from "node:crypto";

type ParentRpcResult = { type: "host-rpc-result"; id: string; ok: boolean; result?: unknown; error?: string };
type Pending = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

const pending = new Map<string, Pending>();
let installed = false;

function installListener(): void {
  if (installed || !process.parentPort) return;
  installed = true;
  process.parentPort.on("message", (event) => {
    const message = event.data as ParentRpcResult;
    if (message?.type !== "host-rpc-result") return;
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    clearTimeout(request.timer);
    if (message.ok) request.resolve(message.result);
    else request.reject(new Error(message.error ?? "Main process request failed"));
  });
}

export function callMain<T>(method: string, params?: unknown, timeoutMs = 10_000): Promise<T> {
  installListener();
  const port = process.parentPort;
  if (!port) return Promise.reject(new Error("Main process channel is unavailable"));
  const id = randomUUID();
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`Main process request timed out: ${method}`));
    }, timeoutMs);
    pending.set(id, { resolve: resolve as (value: unknown) => void, reject, timer });
    port.postMessage({ type: "host-rpc", id, method, params });
  });
}
