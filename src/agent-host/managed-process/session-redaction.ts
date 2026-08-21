import { isManagedProcessToolName } from "./tool-names.ts";

type PersistedMessage = {
  role?: unknown;
  content?: unknown;
  toolName?: unknown;
  details?: unknown;
  [key: string]: unknown;
};

type SessionManagerLike = {
  appendMessage: (message: unknown) => string;
};

const installed = new WeakSet<object>();
const OMITTED_RESULT =
  "[Managed process tool result omitted from disk history. Use process_list/process_read to refresh current state.]";

function redactArguments(toolName: string, value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const args = { ...(value as Record<string, unknown>) };
  if (toolName === "process_start") {
    if ("command" in args) args.command = "[redacted managed process command]";
    if ("cwd" in args) args.cwd = "[redacted managed process cwd]";
  }
  if (toolName === "process_write" && "text" in args) args.text = "[redacted managed process stdin]";
  if ((toolName === "process_wait" || toolName === "process_restart") && "contains" in args) {
    args.contains = "[redacted readiness text]";
  }
  if (toolName === "process_restart" && args.waitFor && typeof args.waitFor === "object") {
    const waitFor = { ...(args.waitFor as Record<string, unknown>) };
    if ("contains" in waitFor) waitFor.contains = "[redacted readiness text]";
    args.waitFor = waitFor;
  }
  return args;
}

export function redactManagedProcessPersistedMessage(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const message = value as PersistedMessage;
  if (
    message.role === "toolResult" &&
    typeof message.toolName === "string" &&
    isManagedProcessToolName(message.toolName)
  ) {
    return {
      ...message,
      content: [{ type: "text", text: OMITTED_RESULT }],
      details: undefined,
    };
  }
  if (message.role !== "assistant" || !Array.isArray(message.content)) return value;
  let changed = false;
  const content = message.content.map((block) => {
    if (!block || typeof block !== "object" || Array.isArray(block)) return block;
    const toolCall = block as { type?: unknown; name?: unknown; arguments?: unknown };
    if (toolCall.type !== "toolCall" || typeof toolCall.name !== "string" || !isManagedProcessToolName(toolCall.name)) {
      return block;
    }
    changed = true;
    return { ...toolCall, arguments: redactArguments(toolCall.name, toolCall.arguments) };
  });
  return changed ? { ...message, content } : value;
}

export function installManagedProcessSessionRedaction(sessionManager: object): void {
  if (installed.has(sessionManager)) return;
  const manager = sessionManager as SessionManagerLike;
  const appendMessage = manager.appendMessage.bind(sessionManager);
  manager.appendMessage = (message: unknown) => appendMessage(redactManagedProcessPersistedMessage(message));
  installed.add(sessionManager);
}
