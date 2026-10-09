import type { AgentMessage } from "@/lib/types";
import type { ModelInfo } from "@contract/types";
import type { ModelReference } from "@contract/model-settings";
import { useI18n } from "@/i18n";
import { scaledChatFont } from "@/lib/chat-appearance";

export function ModelRoutingStatus({
  selection,
  models,
  messages,
}: {
  selection: ModelReference | null;
  models: ModelInfo[];
  messages: AgentMessage[];
}) {
  const { t } = useI18n();
  if (
    !models.some((model) => model.virtual && model.provider === selection?.provider && model.id === selection?.modelId)
  )
    return null;
  const reply = messages.findLast(
    (message) => message.role === "assistant" && message.stopReason !== "error" && message.stopReason !== "aborted",
  );
  if (reply?.role !== "assistant") return null;
  const route = `${reply.provider}/${reply.model}${reply.thinkingLevel ? ` · ${reply.thinkingLevel}` : ""}`;
  const label = `${t("modelRoutedTo", "Last routed model")}: ${route}`;
  return (
    <span
      role="status"
      aria-label={label}
      title={label}
      style={{
        fontSize: scaledChatFont(11),
        color: "var(--text-muted)",
        minWidth: 0,
        maxWidth: "min(320px, 35vw)",
        overflow: "hidden",
        textOverflow: "ellipsis",
        whiteSpace: "nowrap",
      }}
    >
      → {route}
    </span>
  );
}
