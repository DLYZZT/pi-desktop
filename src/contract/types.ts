/** Shared domain types used by the IPC contract. */

import type {
  AgentMessage,
  DeferredContentRef,
  ExtensionStatusItem,
  ExtensionWidgetItem,
  ImageContent,
  SessionTreeNode,
  TextContent,
  ThinkingContent,
  ToolCallContent,
} from "../shared/types";

export interface SessionInfo {
  path: string;
  id: string;
  cwd: string;
  name?: string;
  created: string;
  modified: string;
  messageCount: number;
  firstMessage: string;
  parentSessionId?: string;
  projectRoot?: string;
  worktreeBranch?: string;
}

export interface SessionDetail {
  sessionId: string;
  filePath: string;
  info: SessionInfo | null;
  tree: SessionTreeNode[];
  leafId: string | null;
  context: PagedContextInfo;
  agentState?: {
    running: boolean;
    state?: SessionRuntimeState;
  };
}

export interface ContextInfo {
  messages: AgentMessage[];
  entryIds: string[];
  thinkingLevel: string;
  model: { provider: string; modelId: string } | null;
}

export interface HistoryWindow {
  maxTurns?: number;
  maxBytes?: number;
}

export interface PagedContextInfo extends ContextInfo {
  totalMessages: number;
  loadedMessages: number;
  truncatedBefore: boolean;
  previousCursor?: string;
  historyRevision: string;
}

export interface EntryContentResult {
  content: TextContent | ImageContent | ThinkingContent | ToolCallContent;
  deferredContent: DeferredContentRef;
}

export interface SessionRuntimeState {
  contextUsage?: { percent: number | null; contextWindow: number; tokens: number | null } | null;
  systemPrompt?: string;
  thinkingLevel?: string;
  isStreaming?: boolean;
  isPromptRunning?: boolean;
  isCompacting?: boolean;
  extensionStatuses?: ExtensionStatusItem[];
  extensionWidgets?: ExtensionWidgetItem[];
  queuedMessages?: { steering?: string[]; followUp?: string[] } | null;
  [key: string]: unknown;
}

export interface WorktreeInfo {
  path: string;
  branch?: string | null;
  isMain?: boolean;
}

export interface DirEntry {
  name: string;
  path: string;
  type: "file" | "directory";
  size?: number;
  mtime?: number;
  [key: string]: unknown;
}

export interface FileContent {
  content: string;
  language?: string;
  size?: number;
  truncated?: boolean;
  encoding?: string;
  [key: string]: unknown;
}

export interface FileMeta {
  size: number;
  mtime: number;
  language?: string;
  kind?: string;
  mime?: string;
  [key: string]: unknown;
}

export interface FuzzyMatch {
  path: string;
  score: number;
  [key: string]: unknown;
}

export interface ModelInfo {
  id: string;
  name: string;
  provider: string;
}

export interface ModelsListResult {
  models: ModelInfo[];
  defaultModel: { provider: string; modelId: string } | null;
  thinkingLevels: Record<string, string[]>;
  thinkingLevelMaps: Record<string, Record<string, string | null>>;
  nameMap: Record<string, string>;
}

export interface ModelsConfig {
  [key: string]: unknown;
}

export interface TestResult {
  ok: boolean;
  error?: string;
  [key: string]: unknown;
}

export interface ProviderStatus {
  id: string;
  name: string;
  authenticated?: boolean;
  [key: string]: unknown;
}

export interface SkillInfo {
  name: string;
  description?: string;
  path?: string;
  [key: string]: unknown;
}

export interface AgentCommand {
  type: string;
  [key: string]: unknown;
}

export interface AgentEvent {
  type: string;
  [key: string]: unknown;
}

export interface RunningStateEvent {
  type: "running";
  sessionIds: string[];
}

export interface LoginProgressEvent {
  type: string;
  [key: string]: unknown;
}

export interface RpcErrorShape {
  code: string;
  message: string;
  detail?: unknown;
}

export class RpcError extends Error {
  code: string;
  detail?: unknown;

  constructor(shape: RpcErrorShape) {
    super(shape.message);
    this.name = "RpcError";
    this.code = shape.code;
    this.detail = shape.detail;
  }
}
