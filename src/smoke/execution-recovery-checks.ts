import { createServer } from "node:http";
import { appendFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { HostManager } from "../main/host-manager";
import type { ToolExecutionRecord } from "../contract/executions";
import type { McpPanelSnapshot } from "../contract/mcp";
import { restartHostAfterExit } from "../main/host-install-recovery";

/** Kill the actual utilityProcess at three durable boundaries; the normal Main supervisor restarts it. */
export async function runExecutionRecoveryChecks(manager: HostManager): Promise<void> {
  const agentDir = process.env.PI_CODING_AGENT_DIR!,
    isolated = process.env.PI_DESKTOP_SMOKE_USER_DATA!;
  if (!agentDir?.startsWith(isolated + path.sep)) throw new Error("Execution recovery data is not isolated");
  const directory = path.join(agentDir, "execution-recovery");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const control = path.join(directory, "control.json"),
    checkpoint = path.join(directory, "checkpoint.json"),
    effects = path.join(directory, "effects.jsonl");
  const fixture = path.join(directory, "server.mjs");
  writeFileSync(
    fixture,
    `
import {createInterface} from 'node:readline'; import {appendFileSync,readFileSync,writeFileSync} from 'node:fs'; import path from 'node:path';
const root=process.env.RECOVERY_ROOT;
for await (const line of createInterface({input:process.stdin})) {
  const r=JSON.parse(line); if(r.id===undefined)continue; let result;
  if(r.method==='initialize')result={protocolVersion:r.params.protocolVersion,capabilities:{tools:{}},serverInfo:{name:'recovery',version:'1'}};
  else if(r.method==='tools/list')result={tools:[{name:'effect',inputSchema:{type:'object',properties:{stage:{type:'string',enum:['requested','effect','settled']}},required:['stage']}}]};
  else if(r.method==='tools/call'){
    const stage=r.params.arguments.stage; appendFileSync(path.join(root,'effects.jsonl'),JSON.stringify({stage})+'\\n');
    const c=JSON.parse(readFileSync(path.join(root,'control.json'),'utf8'));
    if(c.stage==='effect'){writeFileSync(path.join(root,'checkpoint.json'),JSON.stringify({stage:'effect'}));continue;}
    result={content:[{type:'text',text:'CRASH_ORIGINAL_'+stage}],structuredContent:{original:'CRASH_ORIGINAL_'+stage}};
  }else result={};
  process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:r.id,result})+'\\n');
}
`,
    { mode: 0o600 },
  );
  writeFileSync(effects, "", { mode: 0o600 });
  const api = <T>(method: string, params?: unknown) => manager.call<T>(method, params, 15000);
  const until = async <T>(read: () => T | Promise<T>, accepts: (value: T) => boolean): Promise<T> => {
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline) {
      const value = await read();
      if (accepts(value)) return value;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error("Execution recovery checkpoint did not settle");
  };
  const server = createServer((request, response) => {
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(chunk as Buffer);
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      const stage = ["requested", "effect", "settled"].find((value) =>
        JSON.stringify(body.messages).includes("CRASH_" + value),
      )!;
      const used = body.messages.some((message: { role: string }) => message.role === "tool");
      const delta = used
        ? { role: "assistant", content: "done" }
        : {
            role: "assistant",
            tool_calls: [
              {
                index: 0,
                id: "crash-parent",
                type: "function",
                function: {
                  name: "codemode",
                  arguments: JSON.stringify({
                    code: `const r=await tools.mcp__crash__effect({stage:${JSON.stringify(stage)}}); text(r.structuredContent.original);`,
                  }),
                },
              },
            ],
          };
      response.writeHead(200, { "content-type": "text/event-stream" });
      for (const [payload, reason] of [
        [delta, null],
        [{}, used ? "stop" : "tool_calls"],
      ])
        response.write(
          "data: " +
            JSON.stringify({
              id: "fixture",
              object: "chat.completion.chunk",
              model: "fixture",
              choices: [{ index: 0, delta: payload, finish_reason: reason }],
            }) +
            "\n\n",
        );
      response.end("data: [DONE]\n\n");
    })().catch(() => {
      response.writeHead(500).end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = "http://127.0.0.1:" + (server.address() as { port: number }).port;
  const sessions: string[] = [];
  try {
    await api("settings.setCacheWarming", { mode: "off" });
    const models = await api<{ version: string; config: { providers?: Record<string, unknown> } }>("modelsConfig.get");
    await api("modelsConfig.set", {
      expectedVersion: models.version,
      config: {
        ...models.config,
        providers: {
          ...models.config.providers,
          "recovery-e2e": {
            baseUrl: base,
            api: "openai-completions",
            models: [
              {
                id: "fixture",
                name: "Recovery fixture",
                reasoning: false,
                input: ["text"],
                contextWindow: 8192,
                maxTokens: 1024,
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              },
            ],
          },
        },
      },
    });
    await api("auth.setApiKey", { provider: "recovery-e2e", key: "isolated-recovery-fixture" });
    const configuration = await api<{ revision: string }>("mcp.config.get", { scope: "global" });
    await api("mcp.config.upsert", {
      scope: "global",
      name: "crash",
      expectedRevision: configuration.revision,
      config: {
        command: process.env.PI_DESKTOP_RUNTIME_PROBE_NODE,
        args: [fixture],
        env: { RECOVERY_ROOT: directory },
        exposure: "codemode",
      },
    });
    for (const [index, stage] of ["requested", "effect", "settled"].entries()) {
      rmSync(checkpoint, { force: true });
      writeFileSync(control, JSON.stringify({ stage, tool: "mcp__crash__effect" }), { mode: 0o600 });
      const created = await api<{ sessionId: string }>("agent.new", {
        type: "ensure_session",
        cwd: directory,
        provider: "recovery-e2e",
        modelId: "fixture",
      });
      const sessionId = created.sessionId;
      sessions.push(sessionId);
      await api("agent.command", { sessionId, command: { type: "get_tools" } });
      await until(
        () => api<McpPanelSnapshot>("mcp.snapshot", { sessionId }),
        (panel) => panel.tools.some((tool) => tool.name === "mcp__crash__effect"),
      );
      await api("mcp.grants", { sessionId, toolNames: ["mcp__crash__effect"] });
      await api("agent.command", {
        sessionId,
        command: { type: "prompt", message: "CRASH_" + stage, clientRunId: 9900 + index },
      });
      await until(
        () => {
          try {
            return JSON.parse(readFileSync(checkpoint, "utf8")) as { stage: string };
          } catch {
            return undefined;
          }
        },
        (value) => value?.stage === stage,
      );
      const pid = manager.getPid();
      if (!pid || pid === process.pid) throw new Error("Cannot identify the owned Agent Host process");
      process.kill(pid, "SIGKILL");
      rmSync(control, { force: true });
      await until(
        async () => {
          if (manager.getStatus() === "crashed") {
            if (index !== 2 || !(await restartHostAfterExit(manager, () => true)))
              throw new Error("Unexpected recovery restart failure");
          }
          return manager.getPid();
        },
        (current) =>
          Boolean(
            current &&
            current !== pid &&
            manager.getStatus() === "ready" &&
            manager.getManagedProcessOwnerState().ready,
          ),
      );
      await api("agent.command", { sessionId, command: { type: "get_tools" } });
      const history = await api<{ records: ToolExecutionRecord[] }>("sessions.executions", {
        id: sessionId,
        includeContent: true,
      });
      const child = history.records.find((record) => record.toolName === "mcp__crash__effect"),
        parent = history.records.find((record) => record.toolName === "codemode");
      const observed = readFileSync(effects, "utf8")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as { stage: string })
        .filter((effect) => effect.stage === stage).length;
      if (observed !== (stage === "requested" ? 0 : 1))
        throw new Error("Recovery replayed or lost an effect: " + stage);
      if (parent?.status !== "interrupted" || !parent.outcomeUnknown || child?.parentToolCallId !== parent.toolCallId)
        throw new Error("Parent interruption or child identity was lost: " + stage);
      if (stage === "settled") {
        if (child.status !== "succeeded" || !JSON.stringify(child.result).includes("CRASH_ORIGINAL_settled"))
          throw new Error("Durable child success was lost after Host crash");
      } else if (child?.status !== "interrupted" || !child.outcomeUnknown)
        throw new Error("Unsettled child must have an unknown outcome: " + stage);
      appendFileSync(
        path.join(directory, "accepted.jsonl"),
        JSON.stringify({ stage, observed, child: child.status, parent: parent.status }) + "\n",
      );
      console.log("execution recovery: " + stage + " passed, effects=" + observed);
      await api("sessions.delete", { id: sessionId, force: true });
    }
  } finally {
    rmSync(control, { force: true });
    if (manager.getStatus() === "ready") {
      for (const sessionId of sessions)
        await api("sessions.delete", { id: sessionId, force: true }).catch(() => undefined);
      const configuration = await api<{ revision: string }>("mcp.config.get", { scope: "global" });
      await api("mcp.config.remove", { scope: "global", name: "crash", expectedRevision: configuration.revision });
    }
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}
