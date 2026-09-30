export type ExecutionStatus =
  "requested" | "running" | "succeeded" | "failed" | "blocked" | "cancelled" | "interrupted";
export interface ExecutionContentRef {
  hash: string;
  bytes: number;
}
export interface ExecutionContentChunk {
  text: string;
  offset: number;
  nextOffset?: number;
  totalBytes: number;
}
export interface ExecutionPayload {
  value?: unknown;
  ref?: ExecutionContentRef;
  preview?: string;
  complete: boolean;
  reason?: string;
  contentOmitted?: boolean;
}
export interface ToolExecutionRecord {
  schemaVersion: 1;
  sessionId: string;
  executionId: string;
  sequence: number;
  runId: string;
  toolCallId: string;
  parentToolCallId?: string;
  rootToolCallId: string;
  anchorEntryId?: string;
  source: "local" | "channel" | "unknown";
  toolName: string;
  status: ExecutionStatus;
  requestedAt: number;
  startedAt?: number;
  endedAt?: number;
  durationMs?: number;
  arguments?: ExecutionPayload;
  result?: ExecutionPayload;
  error?: string;
  isError?: boolean;
  outcomeUnknown?: boolean;
  resourceRefs?: Record<string, string>;
  resourceObservation?: { observedAt: number; state?: string };
  persistenceError?: string;
}
export interface ExecutionQuery {
  executionId?: string;
  parentToolCallId?: string;
  beforeSequence?: number;
  limit?: number;
  includeContent?: boolean;
  maxContentBytes?: number;
}
export interface ExecutionHistoryPage {
  records: ToolExecutionRecord[];
  nextBeforeSequence?: number;
  complete: boolean;
  truncatedTail: boolean;
}

export function validateExecutionQuery(query: ExecutionQuery): void {
  for (const key of ["executionId", "parentToolCallId"] as const)
    if (query[key] !== undefined && (typeof query[key] !== "string" || !query[key]!.length || query[key]!.length > 512))
      throw new Error(`Invalid execution query ${key}`);
  for (const [key, min, max] of [
    ["limit", 1, 200],
    ["beforeSequence", 1, Number.MAX_SAFE_INTEGER],
    ["maxContentBytes", 0, 2097152],
  ] as const)
    if (query[key] !== undefined && (!Number.isSafeInteger(query[key]) || query[key]! < min || query[key]! > max))
      throw new Error(`Invalid execution query ${key}`);
  if (query.includeContent !== undefined && typeof query.includeContent !== "boolean")
    throw new Error("Invalid execution query includeContent");
}
