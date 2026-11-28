import type { AgentMessage, AssistantMessage, BashExecutionMessage, ToolCallContent } from "./types";

function isObject(val: unknown): val is Record<string, unknown> {
  return typeof val === "object" && val !== null && !Array.isArray(val);
}

export function readImagePlaceholderModel(toolName: string | undefined, details: unknown): string | undefined {
  if (toolName !== "read" || !isObject(details)) return;
  return typeof details.imageUnsupportedByModel === "string" ? details.imageUnsupportedByModel : undefined;
}

function normalizeToolCallBlock(block: unknown): ToolCallContent | null {
  if (!isObject(block) || block.type !== "toolCall") return null;
  return {
    type: "toolCall",
    toolCallId: typeof block.toolCallId === "string" ? block.toolCallId : typeof block.id === "string" ? block.id : "",
    toolName: typeof block.toolName === "string" ? block.toolName : typeof block.name === "string" ? block.name : "",
    input:
      typeof block.input === "object" && block.input !== null && !Array.isArray(block.input)
        ? (block.input as Record<string, unknown>)
        : typeof block.arguments === "object" && block.arguments !== null && !Array.isArray(block.arguments)
          ? (block.arguments as Record<string, unknown>)
          : {},
  };
}

export function normalizeToolCalls(msg: AgentMessage): AgentMessage {
  if (msg.role !== "assistant") return msg;
  const content = (msg as AssistantMessage).content;
  if (!Array.isArray(content)) return msg;
  const normalized = content.map((block) => {
    const result = normalizeToolCallBlock(block);
    return result ?? block;
  });
  return { ...msg, content: normalized } as AgentMessage;
}

/** Transcript annotations belong to the Desktop projection, not to persisted or live SDK messages. */
export function normalizeIncomingMessage(message: AgentMessage | BashExecutionMessage): AgentMessage {
  if (message.role === "bashExecution" && !("content" in message)) {
    const { command, output, ...metadata } = message;
    message = {
      ...metadata,
      content: [
        { type: "text", text: command },
        { type: "text", text: output },
      ],
    };
  }
  if (!Object.hasOwn(message, "transcriptNotices")) return normalizeToolCalls(message);
  const raw = { ...message };
  delete raw.transcriptNotices;
  return normalizeToolCalls(raw);
}
