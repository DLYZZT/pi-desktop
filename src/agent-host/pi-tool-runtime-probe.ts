import { copyFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import {
  createAgentSessionServices,
  createAgentSessionFromServices,
  createCodemodeExtension,
  SessionManager,
  SettingsManager,
  type ModelRuntime,
} from "@earendil-works/pi-coding-agent";
import { McpService, type McpServiceOptions } from "./mcp/service";
import { SessionExecutionHistory } from "./session-execution-history";
import { setAgentSessionSource } from "./session-source";

/** Real worker/WASM and MCP protocol exercise under private temporary settings, with no model network. */
export async function probePiToolRuntime(runtime: ModelRuntime, connection?: McpServiceOptions["connection"]) {
  const root = await mkdtemp(path.join(tmpdir(), "pi-tool-runtime-probe-"));
  const mcp = new McpService({ changed() {}, oauth: { updated() {} }, connection }, root);
  const manager = SessionManager.inMemory(root),
    history = new SessionExecutionHistory(manager, root);
  setAgentSessionSource(manager, "local");
  let session: Awaited<ReturnType<typeof createAgentSessionFromServices>>["session"] | undefined;
  try {
    const fixturePath = path.join(root, "mcp-runtime-fixture.mjs");
    if (!connection?.createTransport)
      await copyFile(path.join(path.dirname(fileURLToPath(import.meta.url)), "mcp-runtime-fixture.mjs"), fixturePath);
    await mcp.config.upsert(
      "global",
      undefined,
      "runtime",
      {
        command: process.env.PI_DESKTOP_RUNTIME_PROBE_NODE ?? "node",
        args: [fixturePath],
        exposure: "codemode",
        timeout: 5,
      },
      "missing",
    );
    const services = await createAgentSessionServices({
      cwd: root,
      agentDir: root,
      modelRuntime: runtime,
      settingsManager: SettingsManager.inMemory({ cacheWarming: "off" }),
      resourceLoaderOptions: {
        noSkills: true,
        noThemes: true,
        noPromptTemplates: true,
        noContextFiles: true,
        extensionFactories: [
          history.extension(),
          { name: "codemode", builtin: true, factory: createCodemodeExtension({ models: false }) },
          {
            name: "mcp",
            builtin: true,
            factory: (pi) => {
              pi.on("session_start", async (_event, ctx) =>
                mcp.attach({ pi, ctx, isEmpty: () => false, isRunning: () => false, isAllowed: () => true }),
              );
            },
          },
        ],
      },
    });
    await runtime.setRuntimeApiKey("anthropic", "offline-runtime-probe");
    session = (
      await createAgentSessionFromServices({
        services,
        sessionManager: manager,
        model: runtime.getModel("anthropic", "claude-sonnet-5-5"),
      })
    ).session;
    await session.bindExtensions({ mode: "rpc" });
    const deadline = Date.now() + 10000;
    while (mcp.snapshot(manager.getSessionId())[0]?.state !== "connected") {
      const state = mcp.snapshot(manager.getSessionId())[0];
      if (state?.state === "failed" || Date.now() > deadline)
        throw new Error("Packaged MCP stdio startup failed: " + state?.error);
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const run = async (code: string) => {
      let count = 0;
      session!.agent.streamFunction = (model) => {
        const first = ++count === 1,
          stream = createAssistantMessageEventStream();
        const message = {
          role: "assistant" as const,
          content: first
            ? [{ type: "toolCall" as const, id: "runtime-code", name: "codemode", arguments: { code } }]
            : [{ type: "text" as const, text: "done" }],
          api: model.api,
          provider: model.provider,
          model: model.id,
          stopReason: first ? ("toolUse" as const) : ("stop" as const),
          timestamp: Date.now(),
          usage: {
            input: 1,
            output: 1,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 2,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
        };
        void Promise.resolve().then(() => {
          stream.push({ type: "done", reason: message.stopReason, message });
          stream.end();
        });
        return stream;
      };
      await session!.prompt("Isolated packaged runtime validation", { source: "rpc" });
    };
    await run(
      'const r = await tools.mcp__runtime__echo({text:"PACKAGED_MCP_ORIGINAL"}); text(r.structuredContent.original);',
    );
    const original = (await history.query({ includeContent: true })).records.find(
      (record) => record.toolName === "mcp__runtime__echo",
    );
    if (original?.status !== "succeeded" || !JSON.stringify(original.result).includes("PACKAGED_MCP_ORIGINAL"))
      throw new Error("Packaged Codemode/MCP round-trip failed");
    let waiting = false;
    mcp.getConnection(manager.getSessionId(), "runtime").client.onNotification("notifications/runtime/wait", () => {
      waiting = true;
      void session!.abort();
    });
    const timer = setTimeout(() => {
      void session!.abort();
    }, 10000);
    try {
      await run("await tools.mcp__runtime__wait({});");
    } finally {
      clearTimeout(timer);
    }
    const cancelled = (await history.query()).records.find((record) => record.toolName === "mcp__runtime__wait");
    if (!waiting || cancelled?.status !== "cancelled")
      throw new Error("Packaged Codemode/MCP cancellation failed: " + cancelled?.status);
    return {
      codemodeMcpRoundTrip: true as const,
      codemodeCancellation: true as const,
      mcpStdioRoundTrip: true as const,
    };
  } finally {
    session?.dispose();
    await mcp.shutdown();
    await history.flush();
    await rm(root, { recursive: true, force: true });
  }
}
