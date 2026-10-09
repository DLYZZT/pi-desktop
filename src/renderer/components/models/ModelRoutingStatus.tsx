import type { AgentMessage } from "@/lib/types";
import { useI18n } from "@/i18n";
import { scaledChatFont } from "@/lib/chat-appearance";

export function lastRoutedModel(messages: AgentMessage[]): string | null {
  const reply = messages.findLast(
    (message) => message.role === "assistant" && message.stopReason !== "error" && message.stopReason !== "aborted",
  );
  if (reply?.role !== "assistant") return null;
  return `${reply.provider}/${reply.model}${reply.thinkingLevel ? ` · ${reply.thinkingLevel}` : ""}`;
}

export function ModelRoutingStatus({ route }: { route: string | null }) {
  const { t } = useI18n();
  if (!route) return null;
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
