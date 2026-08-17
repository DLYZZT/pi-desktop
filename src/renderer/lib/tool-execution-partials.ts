import type { TextContent, ToolResultMessage } from "./types";

export function applyToolExecutionUpdate(
  current: ReadonlyMap<string, ToolResultMessage>,
  event: { toolCallId?: unknown; toolName?: unknown; partialResult?: unknown },
): Map<string, ToolResultMessage> {
  const next = new Map(current);
  if (typeof event.toolCallId !== "string" || event.toolCallId.length === 0) return next;
  next.set(event.toolCallId, {
    role: "toolResult",
    toolCallId: event.toolCallId,
    toolName: typeof event.toolName === "string" ? event.toolName : undefined,
    content: extractContent(event.partialResult),
    details: isRecord(event.partialResult) ? event.partialResult.details : undefined,
  });
  return next;
}

export function clearToolExecutionPartial(
  current: ReadonlyMap<string, ToolResultMessage>,
  toolCallId: unknown,
): Map<string, ToolResultMessage> {
  const next = new Map(current);
  if (typeof toolCallId === "string") next.delete(toolCallId);
  return next;
}

export function clearAllToolExecutionPartials(): Map<string, ToolResultMessage> {
  return new Map();
}

function extractContent(partialResult: unknown): TextContent[] {
  if (!isRecord(partialResult) || !Array.isArray(partialResult.content)) return [];
  return partialResult.content.filter(
    (block): block is TextContent => isRecord(block) && block.type === "text" && typeof block.text === "string",
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
