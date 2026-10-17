import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const LEGACY_CHANNEL_PROMPT = /^\[外部消息来源：(微信|Telegram|飞书 \/ Lark)\]\n/;
const LEGACY_CHANNEL_PROMPT_DELIMITER = "\n---\n";

function stripLegacyChannelPromptText(text: string): string {
  if (!LEGACY_CHANNEL_PROMPT.test(text)) return text;
  const delimiter = text.indexOf(LEGACY_CHANNEL_PROMPT_DELIMITER);
  return delimiter < 0 ? text : text.slice(delimiter + LEGACY_CHANNEL_PROMPT_DELIMITER.length);
}

export function stripLegacyChannelPrompts(messages: unknown[]): unknown[] {
  return messages.map((message) => {
    if (!message || typeof message !== "object" || (message as { role?: unknown }).role !== "user") return message;
    const user = message as { content?: unknown };
    if (typeof user.content === "string") {
      const content = stripLegacyChannelPromptText(user.content);
      return content === user.content ? message : { ...message, content };
    }
    if (!Array.isArray(user.content)) return message;

    let changed = false;
    const content = user.content.map((block) => {
      if (!block || typeof block !== "object" || (block as { type?: unknown }).type !== "text") return block;
      const text = (block as { text?: unknown }).text;
      if (typeof text !== "string") return block;
      const stripped = stripLegacyChannelPromptText(text);
      if (stripped === text) return block;
      changed = true;
      return { ...block, text: stripped };
    });
    return changed ? { ...message, content } : message;
  });
}

/** A failed/handled prompt can leave nextTurn messages queued in Pi. Omit only its tagged attachment context. */
export function omitCancelledChannelAttachments(messages: unknown[], cancelledRuns: ReadonlySet<string>): unknown[] {
  return messages.filter((message) => {
    const value = message as { role?: unknown; customType?: unknown; details?: { channelRunId?: unknown } } | null;
    return !(
      value?.role === "custom" &&
      value.customType === "pi-desktop-channel-attachment-context" &&
      typeof value.details?.channelRunId === "string" &&
      cancelledRuns.has(value.details.channelRunId)
    );
  });
}

/** Preserve the raw JSONL while omitting old channel transport wrappers from provider context. */
export function createLegacyChannelContextExtension() {
  return {
    name: "pi-desktop-legacy-channel-context",
    hidden: true,
    factory(pi: ExtensionAPI) {
      pi.on("context", (event, ctx) => {
        const cancelled = new Set(
          ctx.sessionManager.getBranch().flatMap((entry) => {
            if (entry.type !== "custom" || entry.customType !== "pi-desktop-channel-source-cancelled") return [];
            const data = entry.data as { runId?: unknown; discardAttachmentContext?: unknown } | undefined;
            return data?.discardAttachmentContext === true && typeof data.runId === "string" ? [data.runId] : [];
          }),
        );
        const messages = stripLegacyChannelPrompts(event.messages);
        return { messages: omitCancelledChannelAttachments(messages, cancelled) as typeof event.messages };
      });
    },
  };
}
