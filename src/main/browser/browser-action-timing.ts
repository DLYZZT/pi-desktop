import { BrowserError } from "./browser-error.ts";

export async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  code: "ACTION_TIMEOUT" | "JAVASCRIPT_TIMEOUT",
  signal?: AbortSignal,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      callback();
    };
    const onAbort = () =>
      finish(() => reject(new BrowserError("USER_TOOK_CONTROL", "User took control of the Browser tab")));
    const timer = setTimeout(
      () => finish(() => reject(new BrowserError(code, "Browser action timed out", { retryable: true }))),
      timeoutMs,
    );
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();
    promise.then(
      (value) => finish(() => resolve(value)),
      (error) => finish(() => reject(error)),
    );
  });
}

export function abortableDelay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const aborted = () => new BrowserError("USER_TOOK_CONTROL", "User took control of the Browser tab");
    if (signal?.aborted) {
      reject(aborted());
      return;
    }
    let settled = false;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      callback();
    };
    const onAbort = () => finish(() => reject(aborted()));
    const timer = setTimeout(() => finish(resolve), ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
