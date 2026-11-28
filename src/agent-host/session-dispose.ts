import type { AgentSessionLike } from "../shared/pi-types";

/** A hung abort/transport must not prevent releasing the session's own provider resources. */
export async function disposeSdkSession(
  inner: AgentSessionLike,
  options: { abort?: boolean; reason?: string; timeoutMs?: number },
  detachMcp?: () => Promise<void>,
  flushHistory?: () => Promise<void>,
) {
  const { abort = true, reason = "explicit", timeoutMs = 5000 } = options;
  async function attempt(label: string, action: () => unknown) {
    try {
      await action();
    } catch (error) {
      console.warn(
        `[pi-desktop] session ${label} failed during ${reason} for ${inner.sessionId}: ${error instanceof Error ? error.name : "UnknownError"}`,
      );
    }
  }
  const agent = inner.agent as { waitForIdle?: () => Promise<void>; dispose?: () => unknown };
  let finishing: Promise<unknown> | undefined;
  function finish() {
    return (finishing ??= Promise.all([
      attempt("dispose", () => (inner.dispose ? inner.dispose() : agent.dispose?.())),
      attempt("MCP detach", () => detachMcp?.()),
    ]).then(() => attempt("history flush", () => flushHistory?.())));
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      (async () => {
        if (abort) await attempt("abort", () => inner.abort());
        await attempt("waitForIdle", () => agent.waitForIdle?.());
        await finish();
      })(),
      new Promise<void>((resolve) => {
        timer = setTimeout(() => {
          console.warn(`[pi-desktop] session teardown timed out after ${timeoutMs}ms during ${reason}`);
          void finish();
          void attempt("history flush at deadline", () => flushHistory?.());
          resolve();
        }, timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
