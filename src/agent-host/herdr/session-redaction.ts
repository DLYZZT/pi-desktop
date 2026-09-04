import { isHerdrToolName } from "./tool-names.ts";

type PersistedMessage = {
  role?: unknown;
  content?: unknown;
  toolName?: unknown;
  toolCallId?: unknown;
  isError?: unknown;
  [key: string]: unknown;
};

type SessionManagerLike = {
  appendMessage: (message: unknown) => string;
  appendCompaction?: (summary: string, ...rest: unknown[]) => string;
  branchWithSummary?: (entryId: string, summary: string, ...rest: unknown[]) => string;
};

const installed = new WeakSet<object>();
const OMITTED_RESULT = "[Sensitive Herdr result was not saved. Ask Pi to inspect the live Herdr fleet again.]";
const OMITTED_SUMMARY =
  "[A compaction summary containing live Herdr context was not saved. Ask Pi to inspect the live Herdr fleet again.]";
const SAFE_ERROR_CODES = new Set([
  "HERDR_AGENT_BINARY_MISSING",
  "HERDR_AGENT_KIND_UNSUPPORTED",
  "HERDR_AGENT_NOT_READY",
  "HERDR_CWD_FORBIDDEN",
  "HERDR_ENDPOINT_UNAVAILABLE",
  "HERDR_INVALID_REQUEST",
  "HERDR_PANE_NOT_FOUND",
  "HERDR_REQUEST_CANCELLED",
  "HERDR_REQUEST_TIMEOUT",
  "HERDR_SCHEMA_INVALID",
]);

function safeErrorCode(message: PersistedMessage): string | undefined {
  if (message.isError !== true || !Array.isArray(message.content)) return undefined;
  for (const block of message.content) {
    if (!block || typeof block !== "object" || Array.isArray(block)) continue;
    const text = (block as { text?: unknown }).text;
    if (typeof text !== "string") continue;
    const candidate = text.match(/\bHERDR_[A-Z_]+\b/u)?.[0];
    if (candidate && SAFE_ERROR_CODES.has(candidate)) return candidate;
  }
  return undefined;
}

function isHerdrMessage(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const message = value as PersistedMessage;
  if (message.role === "toolResult" && typeof message.toolName === "string") return isHerdrToolName(message.toolName);
  if (message.role !== "assistant" || !Array.isArray(message.content)) return false;
  return message.content.some(
    (block) =>
      Boolean(block) &&
      typeof block === "object" &&
      !Array.isArray(block) &&
      (block as { type?: unknown }).type === "toolCall" &&
      typeof (block as { name?: unknown }).name === "string" &&
      isHerdrToolName((block as { name: string }).name),
  );
}

function redactArguments(toolName: string, value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const args = { ...(value as Record<string, unknown>) };
  if (toolName === "herdr_agent_prompt" && "prompt" in args) args.prompt = "[redacted Herdr agent prompt]";
  if (toolName === "herdr_pane_wait_for_output" && "text" in args) {
    args.text = "[redacted Herdr pane output match]";
  }
  return args;
}

export function redactHerdrPersistedMessage(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const message = value as PersistedMessage;
  if (message.role === "toolResult" && typeof message.toolName === "string" && isHerdrToolName(message.toolName)) {
    const errorCode = safeErrorCode(message);
    const projected: PersistedMessage = {
      role: "toolResult",
      toolName: message.toolName,
      content: [
        {
          type: "text",
          text: errorCode ? `[Herdr tool failed: ${errorCode}. Live Herdr content was not saved.]` : OMITTED_RESULT,
        },
      ],
      isError: message.isError === true,
      ...(errorCode ? { details: { errorCode } } : {}),
    };
    if (typeof message.toolCallId === "string") projected.toolCallId = message.toolCallId;
    return projected;
  }
  if (message.role !== "assistant" || !Array.isArray(message.content)) return value;
  let changed = false;
  const content = message.content.map((block) => {
    if (!block || typeof block !== "object" || Array.isArray(block)) return block;
    const toolCall = block as { type?: unknown; name?: unknown; arguments?: unknown };
    if (toolCall.type !== "toolCall" || typeof toolCall.name !== "string" || !isHerdrToolName(toolCall.name)) {
      return block;
    }
    changed = true;
    return { ...toolCall, arguments: redactArguments(toolCall.name, toolCall.arguments) };
  });
  return changed ? { ...message, content } : value;
}

export function installHerdrSessionRedaction(sessionManager: object): void {
  if (installed.has(sessionManager)) return;
  const manager = sessionManager as SessionManagerLike;
  const appendMessage = manager.appendMessage.bind(sessionManager);
  let sensitiveHerdrContext = false;
  manager.appendMessage = (message: unknown) => {
    if (isHerdrMessage(message)) sensitiveHerdrContext = true;
    return appendMessage(redactHerdrPersistedMessage(message));
  };
  if (typeof manager.appendCompaction === "function") {
    const appendCompaction = manager.appendCompaction.bind(sessionManager);
    manager.appendCompaction = (summary: string, ...rest: unknown[]) => {
      const persistedSummary = sensitiveHerdrContext ? OMITTED_SUMMARY : summary;
      sensitiveHerdrContext = false;
      return appendCompaction(persistedSummary, ...rest);
    };
  }
  if (typeof manager.branchWithSummary === "function") {
    const branchWithSummary = manager.branchWithSummary.bind(sessionManager);
    manager.branchWithSummary = (entryId: string, summary: string, ...rest: unknown[]) => {
      const persistedSummary = sensitiveHerdrContext ? OMITTED_SUMMARY : summary;
      sensitiveHerdrContext = false;
      return branchWithSummary(entryId, persistedSummary, ...rest);
    };
  }
  installed.add(sessionManager);
}
