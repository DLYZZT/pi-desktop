import type { AgentEvent } from "../../contract/types";
import type { ChannelTurnProgressEvent } from "./types";

/** A nested operation stays inside its parent's channel progress card. Raw detail lives in Host history. */
export function projectChannelToolProgress(event: AgentEvent): ChannelTurnProgressEvent | undefined {
  if (event.parentToolCallId) return undefined;
  const identity = { toolCallId: String(event.toolCallId ?? ""), toolName: String(event.toolName ?? "tool") };
  switch (event.type) {
    case "tool_execution_start":
      return { ...identity, type: "tool_start", args: event.args };
    case "tool_execution_update":
      return { ...identity, type: "tool_update", args: event.args, partialResult: event.partialResult };
    case "tool_execution_end":
      return { ...identity, type: "tool_end", result: event.result, isError: event.isError === true };
    default:
      return undefined;
  }
}
