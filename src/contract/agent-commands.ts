import type { SessionStatsInfo } from "../shared/pi-types";
import type { ToolEntry } from "../shared/tool-presets";
import type { ExtensionUiResponse } from "../shared/types";
import type { AgentCommand, SessionRuntimeState } from "./types";

export interface SlashCommandInfo {
  name: string;
  label?: string;
  description?: string;
  source: "extension" | "prompt" | "skill";
  sourceInfo?: {
    path: string;
    source: string;
    scope: "user" | "project" | "temporary";
    origin: "package" | "top-level";
    baseDir?: string;
  };
}

type Prompt = { message: string; images?: Array<{ type: "image"; data: string; mimeType: string }> };
type Command<Params, Result> = { params: Params; result: Result };
type Empty = Record<never, never>;

/** Desktop commands handled by AgentSessionWrapper.send; not a closed wire protocol. */
export interface BuiltinAgentCommands {
  prompt: Command<Prompt & { clientRunId?: number; streamingBehavior?: "steer" | "followUp" }, null>;
  steer: Command<Prompt, null>;
  follow_up: Command<Prompt, null>;
  abort: Command<Empty, null>;
  get_state: Command<Empty, SessionRuntimeState>;
  set_model: Command<{ provider: string; modelId: string }, { id: string; provider: string }>;
  fork: Command<{ entryId: string }, { cancelled: true } | { cancelled: false; newSessionId: string }>;
  navigate_tree: Command<{ targetId: string }, { cancelled: boolean }>;
  set_thinking_level: Command<{ level: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" }, null>;
  compact: Command<{ customInstructions?: string }, { tokensBefore?: number; estimatedTokensAfter?: number }>;
  set_session_name: Command<{ name: string }, null>;
  get_session_stats: Command<Empty, SessionStatsInfo>;
  get_last_assistant_text: Command<Empty, { text: string }>;
  set_auto_compaction: Command<{ enabled: boolean }, null>;
  clear_queue: Command<Empty, { steering: string[]; followUp: string[] }>;
  get_tools: Command<Empty, ToolEntry[]>;
  get_commands: Command<{ input?: string }, { commands: SlashCommandInfo[] }>;
  set_tools: Command<{ toolNames: string[] }, null>;
  reload: Command<Empty, { success: boolean }>;
  abort_compaction: Command<Empty, null>;
  extension_ui_response: Command<ExtensionUiResponse, null>;
  extension_ui_input: Command<{ id: string; data: string }, null>;
  extension_ui_action: Command<{ id: string; action: import("../shared/desktop-custom-ui").CustomUiAction }, null>;
  set_auto_retry: Command<{ enabled: boolean }, null>;
}

export type BuiltinAgentCommand = {
  [K in keyof BuiltinAgentCommands]: { type: K } & BuiltinAgentCommands[K]["params"];
}[keyof BuiltinAgentCommands];

export type BuiltinAgentCommandResult<C extends BuiltinAgentCommand> = BuiltinAgentCommands[C["type"]]["result"];

/** Open commands retain their payload; each handler/SDK validates its own fields. */
export function isAgentCommand(value: unknown): value is AgentCommand {
  return (
    !!value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    "type" in value &&
    typeof value.type === "string" &&
    value.type.trim().length > 0
  );
}
