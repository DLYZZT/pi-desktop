import { BrowserError } from "./browser-error.ts";

export const MAX_REPLAY_RESPONSE_BYTES = 8 * 1024 * 1024;

export async function runBoundedNetworkAction<T>(
  parentSignal: AbortSignal,
  timeoutMs: number,
  task: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  let timedOut = false;
  const onParentAbort = () => controller.abort(parentSignal.reason);
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort(new Error("Browser network action timed out"));
  }, timeoutMs);
  parentSignal.addEventListener("abort", onParentAbort, { once: true });
  if (parentSignal.aborted) onParentAbort();

  try {
    const taskPromise = task(controller.signal);
    const abortPromise = new Promise<never>((_resolve, reject) => {
      const rejectOnAbort = () => reject(controller.signal.reason ?? new Error("Browser network action cancelled"));
      controller.signal.addEventListener("abort", rejectOnAbort, { once: true });
      if (controller.signal.aborted) rejectOnAbort();
      void taskPromise.then(
        () => controller.signal.removeEventListener("abort", rejectOnAbort),
        () => controller.signal.removeEventListener("abort", rejectOnAbort),
      );
    });
    return await Promise.race([taskPromise, abortPromise]);
  } catch (error) {
    if (timedOut) {
      throw new BrowserError("ACTION_TIMEOUT", "Browser network response timed out", {
        retryable: true,
        cause: error,
      });
    }
    if (parentSignal.aborted) {
      throw new BrowserError("USER_TOOK_CONTROL", "Browser network action was cancelled", { cause: error });
    }
    throw error;
  } finally {
    clearTimeout(timer);
    parentSignal.removeEventListener("abort", onParentAbort);
  }
}

export async function readBoundedResponseBody(
  response: Response,
  maxBytes: number,
  signal: AbortSignal,
): Promise<Buffer> {
  const contentLength = parseContentLength(response.headers.get("content-length"));
  if (contentLength !== undefined && contentLength > maxBytes) {
    await response.body?.cancel().catch(() => undefined);
    throw responseTooLarge(maxBytes);
  }
  if (!response.body) return Buffer.alloc(0);

  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let totalBytes = 0;
  const onAbort = () => {
    void reader.cancel(signal.reason).catch(() => undefined);
  };
  signal.addEventListener("abort", onAbort, { once: true });
  if (signal.aborted) onAbort();

  try {
    while (true) {
      if (signal.aborted) throw signal.reason ?? new Error("Browser response read was cancelled");
      const { done, value } = await reader.read();
      if (signal.aborted) throw signal.reason ?? new Error("Browser response read was cancelled");
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw responseTooLarge(maxBytes);
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    signal.removeEventListener("abort", onAbort);
    reader.releaseLock();
  }

  return Buffer.concat(chunks, totalBytes);
}

function parseContentLength(value: string | null): number | undefined {
  if (!value || !/^\d+$/.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

function responseTooLarge(maxBytes: number): BrowserError {
  return new BrowserError("RESULT_TOO_LARGE", `Browser network response exceeds the ${maxBytes} byte limit`);
}
