import { createFauxCore, fauxAssistantMessage, fauxToolCall, type Context } from "@earendil-works/pi-ai";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { BrowserCapabilitySnapshot } from "../contract/browser";
import { browserAgentRuntime } from "../agent-host/browser-agent-runtime";
import { createRpcServer } from "../contract/rpc";
import { browserCapabilityRuntime } from "../agent-host/browser-capability-runtime";
import { registerHandlers } from "../agent-host/handlers";
import { installToolchainGitRunner } from "../agent-host/toolchain-git";
import { getRpcSession, syncBrowserToolsForAllSessions } from "../agent-host/rpc-manager";
import { startSessionWatcher } from "../agent-host/session-watcher";
import { toolchainRuntime } from "../agent-host/toolchain-runtime";
import type { ToolchainSnapshot } from "../shared/toolchains/types";

type BrowserAgentFixtureStatus = {
  sessionId: string;
  sessionFile?: string;
  activeTools: string[];
  isRunning: boolean;
  isStreaming: boolean;
  fauxCallCount: number;
  pendingResponses: number;
  assistantTexts: string[];
  toolResults: string[];
  toolResultTexts: string[];
  browserMetrics: ReturnType<typeof browserAgentRuntime.getMetrics>;
};

type FauxCore = ReturnType<typeof createFauxCore>;

const server = createRpcServer();
const restoreGitRunner = installToolchainGitRunner();
const stopHandlers = registerHandlers(server);
const stopWatcher = startSessionWatcher(server);
const fauxBySession = new Map<string, FauxCore>();

function log(message: string): void {
  process.parentPort?.postMessage({ type: "log", message: `[browser-agent-e2e] ${message}` });
}

function textFromContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter(
      (block): block is { type: "text"; text: string } =>
        Boolean(block) &&
        typeof block === "object" &&
        (block as { type?: unknown }).type === "text" &&
        typeof (block as { text?: unknown }).text === "string",
    )
    .map((block) => block.text)
    .join("\n");
}

function lastToolResult(context: Context, toolName: string): unknown {
  for (let index = context.messages.length - 1; index >= 0; index -= 1) {
    const message = context.messages[index];
    if (message.role !== "toolResult" || message.toolName !== toolName) continue;
    const text = textFromContent(message.content);
    try {
      return JSON.parse(text);
    } catch {
      throw new Error(`${toolName} did not return JSON: ${text.slice(0, 300)}`);
    }
  }
  throw new Error(`Missing ${toolName} result in Faux Provider context`);
}

function lastToolText(context: Context, toolName: string): string {
  for (let index = context.messages.length - 1; index >= 0; index -= 1) {
    const message = context.messages[index];
    if (message.role === "toolResult" && message.toolName === toolName) return textFromContent(message.content);
  }
  throw new Error(`Missing ${toolName} result in Faux Provider context`);
}

function managedProcessContinuation(context: Context) {
  const latest = [...context.messages]
    .reverse()
    .find(
      (message) =>
        message.role === "toolResult" &&
        (message.toolName === "process_wait" || message.toolName === "process_restart"),
    );
  if (!latest || latest.role !== "toolResult") {
    throw new Error("Missing managed process continuation result in Faux Provider context");
  }
  if (latest.toolName === "process_restart") {
    const restarted = lastToolResult(context, "process_restart") as {
      process?: { generation?: unknown; state?: unknown };
      output?: { endpoints?: unknown[] };
    };
    if (restarted.process?.generation !== 2 || !restarted.output?.endpoints?.length) {
      throw new Error("process_restart did not create a ready second generation");
    }
    return fauxAssistantMessage("managed-complete:process+logs+browser+stdin+restart");
  }

  const waited = lastToolResult(context, "process_wait") as {
    nextCursor?: unknown;
    matched?: unknown;
    records?: Array<{ text?: unknown }>;
  };
  const matched =
    typeof waited.matched === "string" || waited.records?.some((record) => record.text === "STDIN electron-input");
  const started = lastToolResult(context, "process_start") as {
    process: { processId: string; runId: string };
  };
  if (matched) {
    return fauxAssistantMessage(
      fauxToolCall("process_restart", {
        processId: started.process.processId,
        runId: started.process.runId,
        waitFor: { type: "loopback-url", timeoutMs: 5_000 },
      }),
      { stopReason: "toolUse" },
    );
  }
  if (typeof waited.nextCursor !== "string") {
    throw new Error("process_wait returned unrelated output without a continuation cursor");
  }
  return fauxAssistantMessage(
    fauxToolCall("process_wait", {
      processId: started.process.processId,
      runId: started.process.runId,
      cursor: waited.nextCursor,
      contains: "STDIN electron-input",
      timeoutMs: 5_000,
    }),
    { stopReason: "toolUse" },
  );
}

function browserResponses(origin: string, managedCommand: string) {
  return [
    fauxAssistantMessage(fauxToolCall("browser_open", { url: origin, profileId: "temporary", activate: true }), {
      stopReason: "toolUse",
    }),
    (context: Context) => {
      const opened = lastToolResult(context, "browser_open") as { id?: unknown };
      if (typeof opened.id !== "string") throw new Error("browser_open did not return a tab ID");
      return fauxAssistantMessage(fauxToolCall("browser_inspect", { tabId: opened.id }), {
        stopReason: "toolUse",
      });
    },
    (context: Context) => {
      const inspection = lastToolResult(context, "browser_inspect") as {
        tabId?: unknown;
        inspectionId?: unknown;
        snapshot?: { nodes?: Array<{ name?: unknown }> };
      };
      if (
        typeof inspection.tabId !== "string" ||
        typeof inspection.inspectionId !== "string" ||
        !Array.isArray(inspection.snapshot?.nodes) ||
        !inspection.snapshot.nodes.some((node) => node.name === "Run Agent action")
      ) {
        throw new Error("read-only Agent inspection did not contain the fixture button");
      }
      return fauxAssistantMessage(`read-complete:assertion=browser_inspect:${inspection.tabId}`);
    },
    (context: Context) => {
      const inspection = lastToolResult(context, "browser_inspect") as {
        tabId?: unknown;
      };
      if (typeof inspection.tabId !== "string") {
        throw new Error("interactive Agent response could not find the owned Browser tab");
      }
      return fauxAssistantMessage(
        fauxToolCall("browser_inspect", { tabId: inspection.tabId, screenshot: { enabled: false } }),
        {
          stopReason: "toolUse",
        },
      );
    },
    (context: Context) => {
      const inspection = lastToolResult(context, "browser_inspect") as {
        tabId?: unknown;
        snapshot?: {
          snapshotId?: unknown;
          generation?: unknown;
          nodes?: Array<{ ref?: unknown; name?: unknown }>;
        };
      };
      const button = inspection.snapshot?.nodes?.find((node) => node.name === "Run Agent action");
      if (
        typeof inspection.tabId !== "string" ||
        typeof inspection.snapshot?.snapshotId !== "string" ||
        typeof inspection.snapshot.generation !== "number" ||
        typeof button?.ref !== "string"
      ) {
        throw new Error("interactive Agent response could not use the fresh Browser inspection reference");
      }
      return fauxAssistantMessage(
        fauxToolCall("browser_click", {
          tabId: inspection.tabId,
          snapshotId: inspection.snapshot.snapshotId,
          generation: inspection.snapshot.generation,
          ref: button.ref,
        }),
        { stopReason: "toolUse" },
      );
    },
    (context: Context) => {
      const clicked = lastToolResult(context, "browser_click") as { tabId?: unknown; action?: unknown };
      if (typeof clicked.tabId !== "string" || clicked.action !== "clicked") {
        throw new Error("browser_click did not complete through the Agent tool adapter");
      }
      return fauxAssistantMessage("interact-complete:assertion=browser_click:clicked");
    },
    fauxAssistantMessage(
      fauxToolCall("browser_open", {
        url: "file:///tmp/pi-phase9-denied",
        profileId: "temporary",
        activate: false,
      }),
      {
        stopReason: "toolUse",
      },
    ),
    fauxAssistantMessage(
      fauxToolCall("bash", {
        command: "touch browser-bypass-marker && curl file:///tmp/pi-phase9-denied",
      }),
      { stopReason: "toolUse" },
    ),
    fauxAssistantMessage("bypass-complete:blocked-before-exec"),
    fauxAssistantMessage(
      fauxToolCall("process_start", {
        command: managedCommand,
        label: "Agent managed Electron fixture",
        kind: "server",
        waitFor: { type: "loopback-url", timeoutMs: 5_000 },
      }),
      { stopReason: "toolUse" },
    ),
    (context: Context) => {
      const started = lastToolResult(context, "process_start") as {
        process?: { processId?: unknown; runId?: unknown };
        endpoints?: Array<{ url?: unknown }>;
      };
      const endpoint = started.endpoints?.[0]?.url;
      if (
        typeof started.process?.processId !== "string" ||
        typeof started.process.runId !== "string" ||
        typeof endpoint !== "string"
      ) {
        throw new Error("process_start did not return a managed endpoint");
      }
      return fauxAssistantMessage(
        fauxToolCall("browser_open", { url: endpoint, profileId: "temporary", activate: true }),
        { stopReason: "toolUse" },
      );
    },
    (context: Context) => {
      const opened = lastToolResult(context, "browser_open") as { id?: unknown };
      if (typeof opened.id !== "string") throw new Error("managed endpoint browser_open did not return a tab ID");
      return fauxAssistantMessage(fauxToolCall("browser_inspect", { tabId: opened.id }), { stopReason: "toolUse" });
    },
    (context: Context) => {
      const inspection = lastToolResult(context, "browser_inspect") as {
        snapshot?: { text?: unknown; nodes?: Array<{ name?: unknown }> };
      };
      if (
        !String(inspection.snapshot?.text ?? "").includes("managed-e2e-ready") &&
        !inspection.snapshot?.nodes?.some((node) => node.name === "managed-e2e-ready")
      ) {
        throw new Error("managed endpoint Browser inspection did not see the fixture page");
      }
      const started = lastToolResult(context, "process_start") as {
        process: { processId: string; runId: string };
      };
      return fauxAssistantMessage(
        fauxToolCall("process_write", {
          processId: started.process.processId,
          runId: started.process.runId,
          text: "electron-input",
        }),
        { stopReason: "toolUse" },
      );
    },
    (context: Context) => {
      const started = lastToolResult(context, "process_start") as {
        process: { processId: string; runId: string };
        output: { nextCursor: string };
      };
      return fauxAssistantMessage(
        fauxToolCall("process_wait", {
          processId: started.process.processId,
          runId: started.process.runId,
          cursor: started.output.nextCursor,
          contains: "STDIN electron-input",
          timeoutMs: 5_000,
        }),
        { stopReason: "toolUse" },
      );
    },
    managedProcessContinuation,
    managedProcessContinuation,
    managedProcessContinuation,
    managedProcessContinuation,
    managedProcessContinuation,
    managedProcessContinuation,
  ];
}

function fixtureStatus(sessionId: string): BrowserAgentFixtureStatus {
  const session = getRpcSession(sessionId);
  if (!session?.isAlive()) throw new Error(`Agent session is unavailable: ${sessionId}`);
  const faux = fauxBySession.get(sessionId);
  const messages = (session.inner.agent.state?.messages ?? []) as Array<{
    role?: unknown;
    content?: unknown;
    toolName?: unknown;
  }>;
  const assistantTexts = messages
    .filter((message) => message.role === "assistant")
    .map((message) => textFromContent(message.content))
    .filter(Boolean);
  const toolResults = messages
    .filter((message) => message.role === "toolResult" && typeof message.toolName === "string")
    .map((message) => message.toolName as string);
  const toolResultTexts = messages
    .filter((message) => message.role === "toolResult" && typeof message.toolName === "string")
    .map((message) => textFromContent(message.content));
  return {
    sessionId,
    ...((session.inner as unknown as { sessionFile?: string }).sessionFile
      ? { sessionFile: (session.inner as unknown as { sessionFile: string }).sessionFile }
      : {}),
    activeTools: session.inner
      .getActiveToolNames()
      .filter((name) => name.startsWith("browser_") || name.startsWith("process_")),
    isRunning: session.isRunning(),
    isStreaming: session.inner.isStreaming,
    fauxCallCount: faux?.state.callCount ?? 0,
    pendingResponses: faux?.getPendingResponseCount() ?? 0,
    assistantTexts,
    toolResults,
    toolResultTexts,
    browserMetrics: browserAgentRuntime.getMetrics(sessionId),
  };
}

server.handle({
  "browserAgentE2e.configure": async (params: unknown) => {
    const body = params as { sessionId?: unknown; origin?: unknown; managedCommand?: unknown };
    if (
      typeof body.sessionId !== "string" ||
      typeof body.origin !== "string" ||
      typeof body.managedCommand !== "string"
    ) {
      throw new Error("browserAgentE2e.configure requires sessionId, origin and managedCommand");
    }
    const session = getRpcSession(body.sessionId);
    if (!session?.isAlive()) throw new Error(`Agent session is unavailable: ${body.sessionId}`);
    if (fauxBySession.has(body.sessionId)) throw new Error("Faux Provider was already configured for this session");

    const provider = `browser-agent-e2e-${process.pid}`;
    const modelId = "browser-agent-e2e-model";
    const faux = createFauxCore({
      api: provider,
      provider,
      models: [{ id: modelId, name: "Browser Agent E2E", reasoning: false, input: ["text"] }],
    });
    faux.setResponses(browserResponses(body.origin, body.managedCommand));
    const modelRuntime = session.inner.modelRuntime as ModelRuntime;
    modelRuntime.registerProvider(provider, {
      name: "Browser Agent E2E",
      baseUrl: "http://127.0.0.1:0",
      api: provider,
      apiKey: "browser-agent-e2e-local-only",
      streamSimple: faux.streamSimple,
      models: [
        {
          id: modelId,
          name: "Browser Agent E2E",
          api: provider,
          reasoning: false,
          input: ["text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 32_000,
          maxTokens: 2_048,
        },
      ],
    });
    fauxBySession.set(body.sessionId, faux);
    await session.send({ type: "set_model", provider, modelId });
    return { provider, modelId };
  },
  "browserAgentE2e.configureManagedFollowup": async (params: unknown) => {
    const body = params as {
      sessionId?: unknown;
      phase?: unknown;
      processId?: unknown;
      runId?: unknown;
    };
    if (
      typeof body.sessionId !== "string" ||
      (body.phase !== "barrier" && body.phase !== "stop") ||
      typeof body.processId !== "string" ||
      typeof body.runId !== "string"
    ) {
      throw new Error("invalid managed followup configuration");
    }
    const faux = fauxBySession.get(body.sessionId);
    if (!faux) throw new Error(`Faux Provider is unavailable: ${body.sessionId}`);
    if (body.phase === "barrier") {
      faux.setResponses([
        fauxAssistantMessage(fauxToolCall("process_restart", { processId: body.processId, runId: body.runId }), {
          stopReason: "toolUse",
        }),
        (context: Context) => {
          if (!lastToolText(context, "process_restart").includes("PROCESS_USER_STOPPED")) {
            throw new Error("Agent restart did not observe the user stop barrier");
          }
          return fauxAssistantMessage("managed-user-stop-barrier-observed");
        },
      ]);
    } else {
      faux.setResponses([
        fauxAssistantMessage(
          fauxToolCall("process_stop", { processId: body.processId, runId: body.runId, mode: "graceful" }),
          { stopReason: "toolUse" },
        ),
        (context: Context) => {
          const stopped = lastToolResult(context, "process_stop") as { state?: unknown };
          if (stopped.state !== "killed" && stopped.state !== "exited") {
            throw new Error("Agent process_stop did not terminate the user-restarted process");
          }
          return fauxAssistantMessage("managed-agent-stop-complete");
        },
      ]);
    }
    return { ok: true };
  },
  "browserAgentE2e.status": async (params: unknown) => {
    const body = params as { sessionId?: unknown };
    if (typeof body.sessionId !== "string") throw new Error("browserAgentE2e.status requires sessionId");
    return fixtureStatus(body.sessionId);
  },
} as never);

const parentPort = process.parentPort;
if (!parentPort) throw new Error("Browser Agent E2E Host requires an Electron utilityProcess parentPort");

parentPort.on("message", (event) => {
  const message = event.data as { type?: string; snapshot?: ToolchainSnapshot | BrowserCapabilitySnapshot };
  if (message.type === "ping") {
    parentPort.postMessage({ type: "pong", ts: Date.now() });
    return;
  }
  if (message.type === "attach-port") {
    const port = event.ports?.[0];
    if (port) server.attachPort(port as never);
    return;
  }
  if (message.type === "toolchain:init" || message.type === "toolchain:changed") {
    if (!message.snapshot) throw new Error("Browser Agent E2E Host received an empty toolchain snapshot");
    toolchainRuntime.apply(message.snapshot as ToolchainSnapshot);
    parentPort.postMessage({ type: "toolchain:ack", revision: message.snapshot.revision });
    return;
  }
  if (message.type === "browser:init" || message.type === "browser:changed") {
    if (!message.snapshot) throw new Error("Browser Agent E2E Host received an empty Browser snapshot");
    browserCapabilityRuntime.apply(message.snapshot as BrowserCapabilitySnapshot);
    syncBrowserToolsForAllSessions();
    parentPort.postMessage({ type: "browser:ack", revision: message.snapshot.revision });
    return;
  }
  if (message.type === "shutdown") {
    stopWatcher();
    restoreGitRunner();
    void stopHandlers().finally(() => process.exit(0));
  }
});

parentPort.postMessage({ type: "ready", ts: Date.now() });
log("ready");
setInterval(() => {}, 1 << 30);
