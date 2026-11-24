// Types mirrored from pi-mono coding-agent session-manager

export interface SessionHeader {
  type: "session";
  version?: number;
  id: string;
  timestamp: string;
  cwd: string;
  parentSession?: string;
}

export interface SessionEntryBase {
  type: string;
  id: string;
  parentId: string | null;
  timestamp: string;
}

export interface TextContent {
  type: "text";
  text: string;
  /** UI transport metadata for content omitted from an initial history page. */
  deferredContent?: DeferredContentRef;
}

export interface DeferredContentRef {
  entryId: string;
  blockIndex?: number;
  originalBytes: number;
  contentType?: "text" | "image" | "thinking" | "toolCall" | "details";
}

export interface ImageContent {
  type: "image";
  source: {
    type: "base64" | "url";
    media_type?: string;
    data?: string;
    url?: string;
  };
  /** UI transport metadata for binary content omitted from an initial history page. */
  deferredContent?: DeferredContentRef;
}

export interface ThinkingContent {
  type: "thinking";
  thinking: string;
  /** UI transport metadata for oversized reasoning omitted from an initial history page. */
  deferredContent?: DeferredContentRef;
}

export interface ToolCallContent {
  type: "toolCall";
  toolCallId: string;
  toolName: string;
  input: Record<string, unknown>;
  /** UI transport metadata for oversized tool input omitted from an initial history page. */
  deferredContent?: DeferredContentRef;
}

export type AssistantContentBlock = TextContent | ImageContent | ThinkingContent | ToolCallContent;

export interface UserMessage {
  role: "user";
  content: string | (TextContent | ImageContent)[];
  /** UI-only origin metadata. It is never projected into the model prompt. */
  channelSource?: "weixin" | "telegram" | "feishu";
  /** UI-only attachment metadata retained by channel source markers. */
  channelAttachments?: ChannelMessageAttachment[];
  timestamp?: number;
}

export interface ChannelMessageAttachment {
  kind: "image" | "voice" | "file" | "video";
  name?: string;
  mime?: string;
}

export interface AssistantMessage {
  thinkingLevel?: string;
  role: "assistant";
  content: AssistantContentBlock[];
  model: string;
  provider: string;
  /** Concrete model reported by the provider; the requested model remains the selection identity. */
  responseModel?: string;
  stopReason?: string;
  errorMessage?: string;
  timestamp?: number;
  usage?: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    cost: {
      input: number;
      output: number;
      cacheRead: number;
      cacheWrite: number;
      total: number;
      totalFromProvider?: boolean;
    };
  };
}

export interface ToolResultMessage {
  role: "toolResult";
  toolCallId: string;
  toolName?: string;
  content: (TextContent | ImageContent)[];
  isError?: boolean;
  details?: unknown;
  /** UI transport metadata for oversized `details` omitted from a history page. */
  deferredDetails?: DeferredContentRef;
  usage?: Usage;
  timestamp?: number;
}

export interface CustomMessage {
  role: "custom";
  customType: string;
  content: string | (TextContent | ImageContent)[];
  display: boolean;
  details?: unknown;
  /** UI transport metadata for oversized `details` omitted from a history page. */
  deferredDetails?: DeferredContentRef;
  timestamp?: number;
}

export type AgentMessage = UserMessage | AssistantMessage | ToolResultMessage | CustomMessage;

/** Raw Pi transcript metadata; never rendered as a chat message. */
export interface SessionSystemMessage {
  role: "system";
  content: string;
  sections?: Record<string, string | null>;
  toolsAdded?: unknown[];
  toolsRemoved?: unknown[];
  timestamp?: number;
}

export interface Usage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens?: number;
  cost: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    total: number;
    totalFromProvider?: boolean;
  };
}

export type ExtensionUiConfirmLocalization =
  | { id: "herdr.closeWorkspace"; target: string; paneCount: number }
  | { id: "herdr.closePane"; target: string }
  | { id: "herdr.closeAgentPane"; paneId: string; agentKind: string }
  | { id: "mcp.authorize"; servers: string; tools: string; toolCount: number };

/** One selectable answer offered by an ask request. */
export interface AskQuestionOption {
  label: string;
  description?: string;
}

/** One question the agent asks through the renderer dialog. */
export interface AskQuestion {
  /** Short chip label shown above the question. */
  header?: string;
  question: string;
  options: AskQuestionOption[];
  /** Allow selecting more than one option. */
  multiSelect?: boolean;
}

/** The user's answer to one ask question. */
export interface AskQuestionAnswer {
  header?: string;
  question: string;
  /** Chosen option labels in display order; empty when only free text was given. */
  selected: string[];
  /** Free text the user typed into the "Other" field. */
  other?: string;
}

export type ExtensionUiRequest =
  | {
      type: "extension_ui_request";
      id: string;
      method: "select";
      title: string;
      options: string[];
      timeout?: number;
      expiresAt?: number;
    }
  | {
      type: "extension_ui_request";
      id: string;
      method: "confirm";
      title: string;
      message: string;
      localization?: ExtensionUiConfirmLocalization;
      timeout?: number;
      expiresAt?: number;
    }
  | {
      type: "extension_ui_request";
      id: string;
      method: "input";
      title: string;
      placeholder?: string;
      timeout?: number;
      expiresAt?: number;
    }
  | {
      type: "extension_ui_request";
      id: string;
      method: "editor";
      title: string;
      prefill?: string;
      timeout?: number;
      expiresAt?: number;
    }
  | {
      type: "extension_ui_request";
      id: string;
      method: "ask";
      questions: AskQuestion[];
      timeout?: number;
      expiresAt?: number;
    }
  | {
      type: "extension_ui_request";
      id: string;
      method: "notify";
      message: string;
      notifyType?: "info" | "warning" | "error";
    }
  | {
      type: "extension_ui_request";
      id: string;
      method: "setStatus";
      statusKey: string;
      statusText?: string;
    }
  | {
      type: "extension_ui_request";
      id: string;
      method: "setWidget";
      widgetKey: string;
      widgetLines?: string[];
      widgetPlacement?: "aboveEditor" | "belowEditor";
    }
  | {
      type: "extension_ui_request";
      id: string;
      method: "setTitle";
      title: string;
    }
  | {
      type: "extension_ui_request";
      id: string;
      method: "set_editor_text";
      text: string;
    }
  | {
      type: "extension_ui_request";
      id: string;
      method: "custom";
      lines: string[];
      closed?: boolean;
    }
  | {
      /**
       * A dialog settled somewhere else (another client answered, it timed
       * out, or the turn aborted). Clients showing that request close it.
       */
      type: "extension_ui_request";
      id: string;
      method: "resolved";
      requestId: string;
    };

export type ExtensionUiResponse =
  | { type: "extension_ui_response"; id: string; value: string }
  | { type: "extension_ui_response"; id: string; confirmed: boolean }
  | { type: "extension_ui_response"; id: string; answers: AskQuestionAnswer[] }
  | { type: "extension_ui_response"; id: string; cancelled: true };

/** One step of the agent's plan, as written by `todo_write`. */
export interface TodoPlanItem {
  content: string;
  status: "pending" | "in_progress" | "completed";
}

/** Plan shown above the composer; `completed` is precomputed for the header. */
export interface TodoPlanState {
  items: TodoPlanItem[];
  completed: number;
}

/** One acceptance criterion as reported by the model through `goal_report`. */
export interface GoalCriterionReport {
  criterion: string;
  met: boolean;
  evidence: string;
}

export interface GoalReportState {
  summary?: string;
  criteria: GoalCriterionReport[];
}

/** `working` runs autonomously; the other states wait for or record a user decision. */
export type GoalStatus = "working" | "awaiting_acceptance" | "budget_exhausted" | "accepted" | "stopped";

/** Decisions the goal panel can send back to the agent host. */
export type GoalResolveAction = "accept" | "reject" | "stop" | "extend";

/** Active `/goal` mode state derived from the session branch; `null` when none. */
export interface GoalState {
  goal: string;
  /** Criteria the user supplied with `/goal`; may be empty. */
  criteria: string[];
  status: GoalStatus;
  continuations: number;
  maxContinuations: number;
  checkpointEvery: number;
  /** Latest self-check report; only present while awaiting acceptance. */
  report: GoalReportState | null;
  /** Feedback from the latest send-back; cleared once the goal moves on. */
  feedback?: string | null;
}

export interface ExtensionStatusItem {
  key: string;
  text: string;
}

export interface ExtensionWidgetItem {
  key: string;
  lines: string[];
  placement: "aboveEditor" | "belowEditor";
}

export interface SessionMessageEntry extends SessionEntryBase {
  type: "message";
  message: AgentMessage | SessionSystemMessage;
}

export interface ThinkingLevelChangeEntry extends SessionEntryBase {
  type: "thinking_level_change";
  thinkingLevel: string;
}

export interface ModelChangeEntry extends SessionEntryBase {
  type: "model_change";
  provider: string;
  modelId: string;
}

export interface CompactionEntry extends SessionEntryBase {
  type: "compaction";
  summary: string;
  firstKeptEntryId: string;
  tokensBefore: number;
  details?: unknown;
  fromHook?: boolean;
  systemMessage?: SessionSystemMessage;
  usage?: Usage;
}

export interface BranchSummaryEntry extends SessionEntryBase {
  type: "branch_summary";
  fromId: string;
  summary: string;
  details?: unknown;
  fromHook?: boolean;
  usage?: Usage;
}

export interface UsageEntry extends SessionEntryBase {
  type: "usage";
  kind: string;
  provider: string;
  model: string;
  usage: Usage;
  note?: string;
}

export interface ContextEditEntry extends SessionEntryBase {
  type: "context_edit";
  targetId: string;
  replacement: { content: string | unknown[] } | null;
}

export interface CustomEntry extends SessionEntryBase {
  type: "custom";
  customType: string;
  data?: unknown;
}

export interface CustomMessageEntry extends SessionEntryBase {
  type: "custom_message";
  customType: string;
  content: string | (TextContent | ImageContent)[];
  details?: unknown;
  display: boolean;
}

export interface LabelEntry extends SessionEntryBase {
  type: "label";
  targetId: string;
  label: string | undefined;
}

export interface SessionInfoEntry extends SessionEntryBase {
  type: "session_info";
  name?: string;
}

export type SessionEntry =
  | SessionMessageEntry
  | ThinkingLevelChangeEntry
  | ModelChangeEntry
  | CompactionEntry
  | BranchSummaryEntry
  | UsageEntry
  | ContextEditEntry
  | CustomEntry
  | CustomMessageEntry
  | LabelEntry
  | SessionInfoEntry;

export type FileEntry = SessionHeader | SessionEntry;

export interface SessionTreeEntry {
  id: string;
  type: string;
  role?: AgentMessage["role"];
  preview?: string;
}

export interface SessionTreeNode {
  entry: SessionTreeEntry;
  children: SessionTreeNode[];
  label?: string;
  compressedEntryIds?: string[];
}

export interface SessionInfo {
  path: string;
  id: string;
  cwd: string;
  name?: string;
  created: string;
  modified: string;
  messageCount: number;
  firstMessage: string;
  parentSessionId?: string; // set if this session was forked from another
  /** Main repo root shared by all worktrees of this cwd (cwd itself for non-git dirs).
   *  Always set by the server; optional because the client builds transient
   *  SessionInfo objects before the first refresh. Fall back to cwd. */
  projectRoot?: string;
  /** Branch name when cwd is a linked git worktree (not the main checkout) */
  worktreeBranch?: string;
}

export interface SessionContext {
  messages: AgentMessage[];
  entryIds: string[]; // parallel to messages — the session entry id for each message
  thinkingLevel: string;
  model: { provider: string; modelId: string } | null;
}
