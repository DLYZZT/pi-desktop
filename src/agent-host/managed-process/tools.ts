import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type {
  ManagedProcessLogWindow,
  ManagedProcessPublicInfo,
  ManagedProcessStartResult,
  ManagedProcessWaitFor,
} from "../../contract/processes.ts";
import { MANAGED_PROCESS_LIMITS } from "../../shared/managed-process-policy.ts";
import { getBrowserSessionSource } from "../browser-tools.ts";
import { ManagedProcessError, type ManagedProcessService } from "./service.ts";
export { isManagedProcessToolName, MANAGED_PROCESS_TOOL_NAMES } from "./tool-names.ts";

type ToolContext = { sessionManager: { getSessionId(): string } };

const processId = Type.String({
  minLength: 1,
  maxLength: 128,
  description: "Managed process id from process_start/list",
});
const runId = Type.String({ minLength: 1, maxLength: 128, description: "Current run id; stale runs are rejected" });
const cursor = Type.String({
  minLength: 3,
  maxLength: 260,
  description: "nextCursor returned by the previous read/wait",
});
const streams = Type.Array(Type.Union([Type.Literal("stdout"), Type.Literal("stderr"), Type.Literal("system")]), {
  minItems: 1,
  maxItems: 3,
  uniqueItems: true,
});
const waitFor = Type.Union([
  Type.Object({ type: Type.Literal("none") }),
  Type.Object({
    type: Type.Literal("output"),
    contains: Type.String({ minLength: 1, maxLength: 256 }),
    timeoutMs: Type.Optional(Type.Integer({ minimum: 0, maximum: MANAGED_PROCESS_LIMITS.startWaitMaxMs })),
  }),
  Type.Object({
    type: Type.Literal("loopback-url"),
    timeoutMs: Type.Optional(Type.Integer({ minimum: 0, maximum: MANAGED_PROCESS_LIMITS.startWaitMaxMs })),
  }),
]);

function text(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }], details: undefined };
}

function toolError(error: unknown): never {
  if (error instanceof ManagedProcessError) throw new Error(`${error.code}: ${error.message}`);
  throw error;
}

function owner(ctx: ToolContext): string {
  return ctx.sessionManager.getSessionId();
}

function assertLocalTurn(ctx: ToolContext): void {
  if (getBrowserSessionSource(ctx.sessionManager) === "channel") {
    throw new ManagedProcessError(
      "PROCESS_FEATURE_DISABLED",
      "Managed process tools are unavailable for messaging-channel turns",
    );
  }
}

async function waitAfterRestart(
  service: ManagedProcessService,
  info: ManagedProcessPublicInfo,
  spec: ManagedProcessWaitFor | undefined,
  sessionId: string,
  signal?: AbortSignal,
): Promise<ManagedProcessLogWindow | undefined> {
  if (!spec || spec.type === "none") return undefined;
  const deadline = Date.now() + Math.min(spec.timeoutMs ?? 1_000, MANAGED_PROCESS_LIMITS.startWaitMaxMs);
  let cursorValue = info.output.earliestCursor;
  let latest: ManagedProcessLogWindow | undefined;
  while (Date.now() < deadline) {
    const remaining = deadline - Date.now();
    latest = await service.wait(
      {
        processId: info.processId,
        runId: info.runId,
        cursor: cursorValue,
        timeoutMs: remaining,
        ...(spec.type === "output" ? { contains: spec.contains } : {}),
      },
      sessionId,
      false,
      signal,
    );
    cursorValue = latest.nextCursor;
    if (latest.state === "ready" || latest.exit || (spec.type === "output" && latest.matched)) return latest;
    if (spec.type === "loopback-url" && latest.endpoints.length > 0) return latest;
    if (latest.timedOut) break;
  }
  return latest;
}

export function createManagedProcessToolDefinitions(
  ownerCwd: string,
  trusted: boolean,
  service: ManagedProcessService,
): ToolDefinition[] {
  return [
    defineTool({
      name: "process_start",
      label: "start managed process",
      description:
        "Start a long-running dev server, watcher, mock API, Storybook, or other persistent project command under Pi Desktop lifecycle control. Use Bash for short commands. Bind servers to 127.0.0.1. Never use &, nohup, disown, setsid, tmux, or external terminals. waitFor observes at most 10 seconds; for longer cold starts continue with process_wait and its returned nextCursor.",
      promptSnippet: "process_start: managed long-running project command; keep runId and output nextCursor",
      parameters: Type.Object({
        command: Type.String({ minLength: 1, maxLength: MANAGED_PROCESS_LIMITS.commandBytes }),
        cwd: Type.Optional(Type.String({ minLength: 1, maxLength: 4_096 })),
        label: Type.Optional(Type.String({ minLength: 1, maxLength: 160 })),
        kind: Type.Optional(Type.Union([Type.Literal("server"), Type.Literal("watcher"), Type.Literal("task")])),
        waitFor: Type.Optional(waitFor),
        activateUi: Type.Optional(Type.Boolean()),
      }),
      executionMode: "sequential",
      async execute(_toolCallId, input, signal, _onUpdate, ctx) {
        try {
          assertLocalTurn(ctx);
          return text(await service.startForAgent(owner(ctx), ownerCwd, trusted, input as never, signal));
        } catch (error) {
          return toolError(error);
        }
      },
    }),
    defineTool({
      name: "process_list",
      label: "list managed processes",
      description: "List managed processes owned by this Agent session. Other sessions are intentionally invisible.",
      parameters: Type.Object({ includeExited: Type.Optional(Type.Boolean()) }),
      executionMode: "sequential",
      async execute(_toolCallId, input, _signal, _onUpdate, ctx) {
        try {
          assertLocalTurn(ctx);
          return text(service.list(input.includeExited === true, owner(ctx)));
        } catch (error) {
          return toolError(error);
        }
      },
    }),
    defineTool({
      name: "process_read",
      label: "read managed process output",
      description:
        "Immediately read a bounded output window. Reuse nextCursor. A gap record means older output was evicted; do not assume the log is complete.",
      parameters: Type.Object({
        processId,
        runId: Type.Optional(runId),
        cursor: Type.Optional(cursor),
        maxBytes: Type.Optional(Type.Integer({ minimum: 1, maximum: MANAGED_PROCESS_LIMITS.agentReadMaxBytes })),
        streams: Type.Optional(streams),
      }),
      executionMode: "sequential",
      async execute(_toolCallId, input, _signal, _onUpdate, ctx) {
        try {
          assertLocalTurn(ctx);
          return text(service.read(input, owner(ctx), false));
        } catch (error) {
          return toolError(error);
        }
      },
    }),
    defineTool({
      name: "process_wait",
      label: "wait for managed process output",
      description:
        "Long-poll for output or a state change without busy polling. A timeout is not an error. For cold starts longer than 30 seconds, call again with the same runId and returned nextCursor until ready, exited, or the task deadline is reached.",
      parameters: Type.Object({
        processId,
        runId: Type.Optional(runId),
        cursor: Type.Optional(cursor),
        timeoutMs: Type.Optional(Type.Integer({ minimum: 0, maximum: MANAGED_PROCESS_LIMITS.waitMaxMs })),
        contains: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
        maxBytes: Type.Optional(Type.Integer({ minimum: 1, maximum: MANAGED_PROCESS_LIMITS.agentReadMaxBytes })),
        streams: Type.Optional(streams),
      }),
      executionMode: "sequential",
      async execute(_toolCallId, input, signal, _onUpdate, ctx) {
        try {
          assertLocalTurn(ctx);
          return text(await service.wait(input, owner(ctx), false, signal));
        } catch (error) {
          return toolError(error);
        }
      },
    }),
    defineTool({
      name: "process_write",
      label: "write managed process stdin",
      description:
        "Write bounded UTF-8 text to an owned process pipe. This is not a PTY: raw-mode shortcuts and full-screen terminal interaction are unsupported. stdin is never persisted.",
      parameters: Type.Object({
        processId,
        runId,
        text: Type.String({ maxLength: MANAGED_PROCESS_LIMITS.stdinBytes }),
        appendNewline: Type.Optional(Type.Boolean()),
        close: Type.Optional(Type.Boolean()),
      }),
      executionMode: "sequential",
      async execute(_toolCallId, input, _signal, _onUpdate, ctx) {
        try {
          assertLocalTurn(ctx);
          return text(service.write(input, owner(ctx)));
        } catch (error) {
          return toolError(error);
        }
      },
    }),
    defineTool({
      name: "process_stop",
      label: "stop managed process",
      description:
        "Stop the current run and its complete process group. Keep the current runId; stale generations are rejected. Never fall back to shell kill commands.",
      parameters: Type.Object({
        processId,
        runId,
        mode: Type.Optional(Type.Union([Type.Literal("graceful"), Type.Literal("force")])),
      }),
      executionMode: "sequential",
      async execute(_toolCallId, input, _signal, _onUpdate, ctx) {
        try {
          assertLocalTurn(ctx);
          return text(await service.stop(input.processId, input.runId, input.mode, "agent", owner(ctx)));
        } catch (error) {
          return toolError(error);
        }
      },
    }),
    defineTool({
      name: "process_restart",
      label: "restart managed process",
      description:
        "Fully stop the current process group, then start a new generation. A user stop barrier cannot be overridden by the Agent.",
      parameters: Type.Object({ processId, runId, waitFor: Type.Optional(waitFor) }),
      executionMode: "sequential",
      async execute(_toolCallId, input, signal, _onUpdate, ctx) {
        try {
          assertLocalTurn(ctx);
          const sessionId = owner(ctx);
          const process = await service.restart(input.processId, input.runId, "agent", sessionId, trusted);
          const output = await waitAfterRestart(service, process, input.waitFor, sessionId, signal);
          return text({ process, ...(output ? { output } : {}) });
        } catch (error) {
          return toolError(error);
        }
      },
    }),
  ];
}

export function formatManagedProcessStartForAgent(result: ManagedProcessStartResult): string {
  const lines = [
    `Process ${result.process.processId} is ${result.state} (${result.process.label}, run ${result.process.generation}).`,
    `Readiness: ${result.readiness.state}${result.readiness.matched ? ` — ${result.readiness.matched}` : ""}`,
    `Output cursor: ${result.output.nextCursor}`,
  ];
  for (const record of result.output.records) lines.push(`[${record.stream}] ${record.text}`);
  return lines.join("\n");
}
