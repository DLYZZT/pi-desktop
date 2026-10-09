import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { TestResult } from "../contract/types";

/** Sends one tiny uncached request to verify a chat model's credentials and endpoint. */
export async function probeChatModel(
  runtime: Pick<ModelRuntime, "completeSimple">,
  model: Parameters<ModelRuntime["completeSimple"]>[0],
  timeoutMs: number,
): Promise<TestResult> {
  const signal = AbortSignal.timeout(timeoutMs);
  let status: number | undefined;
  const startedAt = Date.now();
  const message = await runtime.completeSimple(
    model,
    { messages: [{ role: "user", content: "Reply with OK only.", timestamp: Date.now() }] },
    {
      maxTokens: 16,
      timeoutMs,
      maxRetries: 0,
      cacheRetention: "none",
      signal,
      onResponse: (response: { status: number }) => {
        status = response.status;
      },
    },
  );
  const latencyMs = Date.now() - startedAt;
  if (message.stopReason === "error" || message.stopReason === "aborted")
    return {
      ok: false,
      error: message.errorMessage ?? (signal.aborted ? "Test timed out" : "Model returned an error"),
      latencyMs,
      status,
    };
  const responseText = message.content
    .flatMap((block) => (block.type === "text" ? [block.text] : []))
    .join("")
    .slice(0, 300);
  return { ok: true, latencyMs, status, responseText };
}
