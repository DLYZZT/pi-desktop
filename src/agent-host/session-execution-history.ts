import { randomUUID } from "node:crypto";
import type { ExtensionAPI, SessionManager } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { ExecutionHistoryPage, ExecutionQuery, ToolExecutionRecord } from "../contract/executions";
import { validateExecutionQuery } from "../contract/executions";
import { ExecutionLogStore, isTerminalExecution } from "./execution-log-store";
import { getAgentSessionSource } from "./session-source";

type ToolEvent = {
  toolCallId: string;
  toolName: string;
  parentToolCallId?: string;
  args?: unknown;
  result?: unknown;
  isError?: boolean;
};
type StoredExecution = Omit<ToolExecutionRecord, "schemaVersion" | "sessionId" | "sequence">;
type HistoryManager = Pick<SessionManager, "getSessionId" | "getBranch">;

/** Durable history of tool effects; has no tool execution or automatic replay capability. */
export class SessionExecutionHistory {
  readonly store: ExecutionLogStore;
  private runId = randomUUID();
  private active = new Map<string, StoredExecution>();
  private writeFailures = new Map<string, string>();
  constructor(
    private readonly manager: HistoryManager,
    root?: string,
  ) {
    this.store = new ExecutionLogStore(manager.getSessionId(), root);
  }

  async recover(): Promise<void> {
    await this.store.recoverInterrupted();
  }
  async flush(): Promise<void> {
    await this.store.flush();
  }
  private anchor(): string | undefined {
    return [...this.manager.getBranch()]
      .reverse()
      .find((entry) => entry.type === "message" && entry.message.role === "assistant")?.id;
  }
  private key(callId: string): string {
    return `${this.runId}:${callId}`;
  }
  async requested(event: ToolEvent): Promise<StoredExecution> {
    const key = this.key(event.toolCallId),
      previous = this.active.get(key);
    if (previous) return previous;
    const parent = event.parentToolCallId ? this.active.get(this.key(event.parentToolCallId)) : undefined;
    const entry: StoredExecution = {
      executionId: randomUUID(),
      runId: this.runId,
      toolCallId: event.toolCallId,
      ...(event.parentToolCallId ? { parentToolCallId: event.parentToolCallId } : {}),
      rootToolCallId: parent?.rootToolCallId ?? event.parentToolCallId ?? event.toolCallId,
      anchorEntryId: parent?.anchorEntryId ?? this.anchor(),
      source: getAgentSessionSource(this.manager),
      toolName: event.toolName,
      status: "requested",
      requestedAt: Date.now(),
      arguments: await this.store.payload(event.args ?? {}),
    };
    await this.store.append(entry);
    this.active.set(key, entry);
    return entry;
  }
  async running(event: ToolEvent): Promise<void> {
    const entry = await this.requested(event);
    if (this.writeFailures.has(this.key(event.toolCallId)))
      throw new Error("Execution history could not persist the request");
    if (isTerminalExecution(entry.status)) throw new Error("Tool execution ID has already settled");
    const next = { ...entry, status: "running" as const, startedAt: Date.now() };
    await this.store.append(next);
    this.active.set(this.key(event.toolCallId), next);
  }
  async ended(event: ToolEvent): Promise<void> {
    const entry = await this.requested(event);
    if (isTerminalExecution(entry.status)) return;
    const result = event.result as
      { content?: { type: string; text?: string }[]; details?: unknown; isError?: boolean } | undefined;
    const text =
      result?.content
        ?.filter((block) => block.type === "text")
        .map((block) => block.text ?? "")
        .join("\n") ?? "";
    const error = event.isError || result?.isError;
    const status = !error
      ? "succeeded"
      : /TOOL_PERMISSION_DENIED|not authorized|not found/iu.test(text)
        ? "blocked"
        : /abort|cancel/iu.test(text)
          ? "cancelled"
          : "failed";
    const endedAt = Date.now(),
      next: StoredExecution = {
        ...entry,
        status,
        endedAt,
        durationMs: endedAt - (entry.startedAt ?? entry.requestedAt),
        isError: Boolean(error),
        ...(error ? { error: text.slice(0, 8192) } : {}),
        result: await this.store.payload(event.result),
      };
    const refs: Record<string, string> = {};
    let observed = result?.details;
    if (!observed && text.length < 2 * 1024 * 1024) {
      try {
        observed = JSON.parse(text) as unknown;
      } catch {
        /* Ordinary text result. */
      }
    }
    if (observed && typeof observed === "object") {
      const values = observed as Record<string, unknown>;
      for (const item of [values, values.process, values.agent, values.pane]) {
        if (!item || typeof item !== "object") continue;
        for (const name of ["processId", "runId", "paneId", "agentId", "tabId", "workspaceId"]) {
          const value = (item as Record<string, unknown>)[name];
          if (typeof value === "string") refs[name] = value;
        }
      }
      if (Object.keys(refs).length) {
        next.resourceRefs = refs;
        next.resourceObservation = {
          observedAt: endedAt,
          ...(typeof values.state === "string" ? { state: values.state } : {}),
        };
      }
    }
    await this.store.append(next);
    this.active.set(this.key(event.toolCallId), next);
  }

  async query(
    query: ExecutionQuery = {},
    source?: "local" | "channel",
    excludeLookups = false,
  ): Promise<ExecutionHistoryPage> {
    validateExecutionQuery(query);
    const branch = new Set(this.manager.getBranch().map((entry) => entry.id));
    return this.store.readLatest({ ...query, limit: Math.min(200, query.limit ?? 50) }, branch, {
      project: true,
      ...(source === "channel" ? { source } : {}),
      ...(excludeLookups && !query.executionId ? { excludeTool: "tool_history_get" } : {}),
    });
  }
  projectEvent<T extends { type: string; [key: string]: unknown }>(event: T): T {
    if (event.type !== "tool_execution_end" && event.type !== "tool_execution_update") return event;
    const value = (event.result ?? event.partialResult) as Record<string, unknown> | undefined;
    const { structuredContent: _structured, ...result } = value ?? {};
    const key = typeof event.toolCallId === "string" ? this.key(event.toolCallId) : "";
    const record = this.active.get(key);
    if (Array.isArray(result.content))
      result.content = result.content.map((block: Record<string, unknown>) =>
        block.type === "text" && typeof block.text === "string" && block.text.length > 8192
          ? { ...block, text: block.text.slice(0, 8192), contentOmitted: true }
          : block,
      );
    try {
      if (result.details && JSON.stringify(result.details).length > 4096)
        result.details = { executionId: record?.executionId, contentOmitted: true };
    } catch {
      result.details = { executionId: record?.executionId, contentOmitted: true };
    }
    return {
      ...event,
      ...(value ? { [event.type === "tool_execution_end" ? "result" : "partialResult"]: result } : {}),
      executionId: record?.executionId,
      executionStatus: record?.status,
      executionResultRef: record?.result?.ref,
      ...(this.writeFailures.has(key) ? { persistenceError: this.writeFailures.get(key) } : {}),
    };
  }
  tool() {
    return {
      name: "tool_history_get",
      label: "Tool execution history",
      description:
        "Read the current branch's prior tool execution states and original results by execution ID or parent call. For large original data, specify contentField and contentOffset to page through its JSON text. Does not execute or retry tools. Use this after resume, compaction or an interrupted operation.",
      parameters: Type.Object({
        executionId: Type.Optional(Type.String()),
        parentToolCallId: Type.Optional(Type.String()),
        beforeSequence: Type.Optional(Type.Integer({ minimum: 1 })),
        limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200 })),
        includeContent: Type.Optional(Type.Boolean()),
        maxContentBytes: Type.Optional(Type.Integer({ minimum: 0, maximum: 2097152 })),
        contentField: Type.Optional(Type.Union([Type.Literal("arguments"), Type.Literal("result")])),
        contentOffset: Type.Optional(Type.Integer({ minimum: 0 })),
      }),
      execute: async (
        _id: string,
        params: ExecutionQuery & { contentField?: "arguments" | "result"; contentOffset?: number },
      ) => {
        const source = getAgentSessionSource(this.manager) === "channel" ? "channel" : "local";
        const page = await this.query(params, source, true);
        let value: unknown = page;
        if (params.contentField) {
          if (!params.executionId) throw new Error("An execution ID is required for original content pages");
          const payload = page.records[0]?.[params.contentField];
          if (!payload?.ref) throw new Error("No large content reference; use includeContent for inline data");
          value = {
            executionId: params.executionId,
            field: params.contentField,
            chunk: await this.store.readContentChunk(
              payload.ref.hash,
              params.contentOffset ?? 0,
              params.maxContentBytes ?? 65536,
            ),
          };
        }
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(value),
            },
          ],
          details: undefined,
        };
      },
    };
  }
  extension() {
    return {
      name: "pi-desktop-execution-history",
      hidden: true,
      factory: (pi: ExtensionAPI) => {
        pi.on("turn_start", () => {
          this.runId = randomUUID();
          this.active.clear();
          this.writeFailures.clear();
        });
        pi.on("tool_execution_start", async (event) => {
          try {
            await this.requested(event);
          } catch {
            this.writeFailures.set(this.key(event.toolCallId), "Execution request was not durably recorded");
          }
        });
        pi.on("tool_call", async (event) => {
          try {
            await this.running({ ...event, args: event.input });
          } catch {
            return { block: true, reason: "EXECUTION_HISTORY_UNAVAILABLE: request was blocked before execution" };
          }
        });
        pi.on("tool_execution_end", async (event) => {
          try {
            await this.ended(event);
          } catch {
            this.writeFailures.set(this.key(event.toolCallId), "Execution completion was not durably recorded");
          }
        });
        pi.on("context", async (event) => {
          const page = await this.query(
            { limit: 8 },
            getAgentSessionSource(this.manager) === "channel" ? "channel" : "local",
            true,
          );
          if (!page.records.length && !this.writeFailures.size) return;
          const records = page.records.map(({ executionId, toolName, status, resourceRefs }) => ({
            executionId,
            toolName,
            status,
            resourceRefs,
          }));
          return {
            messages: [
              ...event.messages,
              {
                role: "custom",
                customType: "pi-desktop-execution-state",
                content: `Recorded tool execution states (historical observations): ${JSON.stringify(records)}. History complete: ${page.complete}. Persistence failures: ${JSON.stringify([...this.writeFailures.values()])}. Use tool_history_get for original results and verification before repeating interrupted effects.`,
                display: false,
                timestamp: Date.now(),
              },
            ],
          };
        });
      },
    };
  }
}
