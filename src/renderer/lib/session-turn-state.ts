import type { AgentEvent } from "../../contract/types.ts";
import type { AgentMessage } from "../../shared/types.ts";
import { normalizeToolCalls } from "../../shared/normalize.ts";

export interface StreamingState {
  isStreaming: boolean;
  streamingMessage: Partial<AgentMessage> | null;
}

export type StreamAction =
  { type: "start" } | { type: "update"; message: Partial<AgentMessage> } | { type: "end" } | { type: "reset" };

export interface QueuedMessages {
  steering: string[];
  followUp: string[];
}

export type AgentPhase =
  | { kind: "waiting_model" }
  | { kind: "running_command" }
  | { kind: "running_tools"; tools: { id: string; name: string }[] }
  | null;

export interface CompactResultInfo {
  reason: string;
  tokensBefore: number;
  estimatedTokensAfter: number;
}

export interface SessionTurnState {
  streamState: StreamingState;
  agentRunning: boolean;
  agentPhase: AgentPhase;
  retryInfo: { attempt: number; maxAttempts: number; errorMessage?: string } | null;
  isCompacting: boolean;
  compactError: string | null;
  compactResult: CompactResultInfo | null;
  queuedMessages: QueuedMessages;
}

export type SessionTurnAction =
  | { type: "start"; phase?: "waiting_model" | "running_command" }
  | { type: "settled" }
  | { type: "send-failed" }
  | { type: "running"; running: boolean }
  | { type: "stream"; action: StreamAction }
  | { type: "event"; event: AgentEvent }
  | { type: "queue-snapshot"; queuedMessages: QueuedMessages }
  | { type: "compaction-start" }
  | { type: "compaction-state"; isCompacting: boolean }
  | { type: "compaction-error"; error: string | null }
  | { type: "compaction-result"; result: CompactResultInfo | null };

export function createSessionTurnState(): SessionTurnState {
  return {
    streamState: { isStreaming: false, streamingMessage: null },
    agentRunning: false,
    agentPhase: null,
    retryInfo: null,
    isCompacting: false,
    compactError: null,
    compactResult: null,
    queuedMessages: { steering: [], followUp: [] },
  };
}

export function streamReducer(state: StreamingState, action: StreamAction): StreamingState {
  switch (action.type) {
    case "start":
      return { isStreaming: true, streamingMessage: null };
    case "update":
      return { isStreaming: true, streamingMessage: action.message };
    case "end":
    case "reset":
      return { isStreaming: false, streamingMessage: null };
    default:
      return state;
  }
}

export function readCompactResult(result: unknown, reason: string): CompactResultInfo | null {
  if (!result || typeof result !== "object") return null;
  const value = result as Partial<CompactResultInfo>;
  if (typeof value.tokensBefore !== "number" || typeof value.estimatedTokensAfter !== "number") return null;
  return { reason, tokensBefore: value.tokensBefore, estimatedTokensAfter: value.estimatedTokensAfter };
}

function copyQueue(queued: QueuedMessages): QueuedMessages {
  return { steering: [...queued.steering], followUp: [...queued.followUp] };
}

/** Only projects a turn's render state. History, RPC, timers and DOM effects stay with their owners. */
export function reduceSessionTurnState(state: SessionTurnState, action: SessionTurnAction): SessionTurnState {
  switch (action.type) {
    case "start":
      return {
        ...state,
        agentRunning: true,
        agentPhase: { kind: action.phase ?? "waiting_model" },
        streamState: streamReducer(state.streamState, { type: "start" }),
      };
    case "settled":
    case "send-failed":
      return {
        ...state,
        agentRunning: false,
        agentPhase: null,
        retryInfo: action.type === "settled" ? null : state.retryInfo,
        streamState: streamReducer(state.streamState, { type: "end" }),
      };
    case "running":
      return { ...state, agentRunning: action.running };
    case "stream":
      return { ...state, streamState: streamReducer(state.streamState, action.action) };
    case "queue-snapshot":
      return { ...state, queuedMessages: copyQueue(action.queuedMessages) };
    case "compaction-start":
      return { ...state, isCompacting: true, compactError: null, compactResult: null };
    case "compaction-state":
      return { ...state, isCompacting: action.isCompacting };
    case "compaction-error":
      return { ...state, compactError: action.error };
    case "compaction-result":
      return { ...state, compactResult: action.result };
    case "event":
      return reduceAgentEvent(state, action.event);
  }
}

function reduceAgentEvent(state: SessionTurnState, event: AgentEvent): SessionTurnState {
  switch (event.type) {
    case "agent_start":
      return reduceSessionTurnState(state, { type: "start" });
    // One prompt may contain several SDK runs; only confirmed prompt settlement ends it.
    case "agent_end":
    case "prompt_done":
      return state;
    case "message_start":
    case "message_update": {
      const role = (event.message as { role?: unknown } | undefined)?.role;
      if (!state.agentRunning || role === "system" || role === "user") return state;
      const message = event.message as Partial<AgentMessage> | undefined;
      return {
        ...state,
        agentPhase: null,
        streamState: message
          ? streamReducer(state.streamState, { type: "update", message: normalizeToolCalls(message as AgentMessage) })
          : state.streamState,
      };
    }
    case "message_end":
      if (!state.agentRunning || (event.message as { role?: string } | undefined)?.role === "system") return state;
      return {
        ...state,
        agentPhase: { kind: "waiting_model" },
        streamState: streamReducer(state.streamState, { type: "reset" }),
      };
    case "tool_execution_start": {
      const id = event.toolCallId as string;
      const name = event.toolName as string;
      const tools = state.agentPhase?.kind === "running_tools" ? [...state.agentPhase.tools] : [];
      if (!tools.some((tool) => tool.id === id)) tools.push({ id, name });
      return { ...state, agentPhase: { kind: "running_tools", tools } };
    }
    case "tool_execution_end": {
      if (state.agentPhase?.kind !== "running_tools") return state;
      const tools = state.agentPhase.tools.filter((tool) => tool.id !== event.toolCallId);
      return { ...state, agentPhase: tools.length ? { kind: "running_tools", tools } : { kind: "waiting_model" } };
    }
    case "queue_update":
      return {
        ...state,
        queuedMessages: copyQueue({
          steering: (event.steering as string[] | undefined) ?? [],
          followUp: (event.followUp as string[] | undefined) ?? [],
        }),
      };
    case "auto_retry_start":
      return {
        ...state,
        retryInfo: {
          attempt: event.attempt as number,
          maxAttempts: event.maxAttempts as number,
          errorMessage: event.errorMessage as string | undefined,
        },
      };
    case "auto_retry_end":
      return { ...state, retryInfo: null };
    case "auto_compaction_start":
    case "compaction_start":
      return reduceSessionTurnState(state, { type: "compaction-start" });
    case "auto_compaction_end":
    case "compaction_end": {
      const stopped = { ...state, isCompacting: false };
      if (event.errorMessage) return { ...stopped, compactError: event.errorMessage as string, compactResult: null };
      if (event.aborted) return stopped;
      return {
        ...stopped,
        compactResult: readCompactResult(event.result, (event.reason as string | undefined) ?? "auto"),
      };
    }
    default:
      return state;
  }
}
