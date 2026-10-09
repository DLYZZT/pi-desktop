import { getAssistantFailureDetail, isAssistantAborted, isAssistantFailure } from "@/lib/message-display";
import { scaledChatFont } from "@/lib/chat-appearance";
import type { AssistantMessage } from "@/lib/types";
import { useI18n } from "@/i18n";

export function AssistantOutcome({ message, isStreaming }: { message: AssistantMessage; isStreaming?: boolean }) {
  const { t } = useI18n();
  const aborted = isAssistantAborted(message);
  if (isStreaming || (!aborted && !isAssistantFailure(message))) return null;
  const detail = aborted
    ? null
    : (getAssistantFailureDetail(message) ??
      t(
        "modelRequestFailedFallback",
        "The model service did not return error details. Check the API key, service URL, and model configuration.",
      ));
  return (
    <div
      role={aborted ? "status" : "alert"}
      data-testid={aborted ? "assistant-stopped-message" : "assistant-error-message"}
      style={{
        border: aborted ? "1px solid var(--border)" : "1px solid color-mix(in srgb, var(--danger) 45%, var(--border))",
        borderRadius: 9,
        background: aborted ? "var(--assistant-bg)" : "color-mix(in srgb, var(--danger) 8%, var(--assistant-bg))",
        color: aborted ? "var(--text-muted)" : "var(--danger)",
        padding: "10px 12px",
        fontSize: scaledChatFont(13),
        lineHeight: 1.55,
        overflowWrap: "anywhere",
        whiteSpace: "pre-wrap",
      }}
    >
      <div style={{ fontWeight: 600, marginBottom: detail ? 3 : 0 }}>
        {aborted ? t("agentResponseStopped", "Response stopped") : t("modelRequestFailed", "Model request failed")}
      </div>
      {detail && <div>{detail}</div>}
    </div>
  );
}
