import { createServer } from "node:http";
import type { BrowserWindow } from "electron";
import type { McpPanelSnapshot } from "../contract/mcp";
import { runMcpPresentationChecks } from "./mcp-presentation-checks";
import { captureSettingsReferences } from "./settings-reference-capture";
type Call = <T = unknown>(method: string, params?: unknown) => Promise<T>;

export async function runMcpUiChecks(window: BrowserWindow, call: Call): Promise<void> {
  let mcpCalls = 0;
  const server = createServer((request, response) => {
    void (async () => {
      if (request.method !== "POST") {
        response.writeHead(405).end();
        return;
      }
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(chunk as Buffer);
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      if (request.url?.startsWith("/v1/")) {
        const execute = body.messages.some(
          (message: { role: string; content?: unknown }) =>
            message.role === "user" && JSON.stringify(message.content).includes("MCP_EXECUTE"),
        );
        const tool = execute && !body.messages.some((message: { role: string }) => message.role === "tool");
        response.writeHead(200, { "content-type": "text/event-stream" });
        const delta = tool
          ? {
              role: "assistant",
              tool_calls: [
                {
                  index: 0,
                  id: "mcp-e2e-call",
                  type: "function",
                  function: {
                    name: "codemode",
                    arguments: JSON.stringify({
                      code: 'const result = await tools.mcp__smoke__echo({text: "MCP_ORIGINAL"}); text(result.structuredContent.original);',
                    }),
                  },
                },
              ],
            }
          : { role: "assistant", content: "MCP_E2E_DONE" };
        response.write(
          "data: " +
            JSON.stringify({
              id: "fixture",
              object: "chat.completion.chunk",
              model: "fixture",
              choices: [{ index: 0, delta, finish_reason: null }],
            }) +
            "\n\n",
        );
        response.write(
          "data: " +
            JSON.stringify({
              id: "fixture",
              object: "chat.completion.chunk",
              model: "fixture",
              choices: [{ index: 0, delta: {}, finish_reason: tool ? "tool_calls" : "stop" }],
              usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
            }) +
            "\n\ndata: [DONE]\n\n",
        );
        response.end();
        return;
      }
      if (body.id === undefined) {
        response.writeHead(202).end();
        return;
      }
      const result =
        body.method === "initialize"
          ? {
              protocolVersion: body.params.protocolVersion,
              capabilities: { tools: {} },
              serverInfo: { name: "smoke", version: "1" },
            }
          : body.method === "tools/list"
            ? {
                tools: [
                  {
                    name: "echo",
                    inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
                  },
                ],
              }
            : {
                content: [{ type: "text", text: body.params.arguments.text }],
                structuredContent: { original: body.params.arguments.text },
              };
      if (body.method === "tools/call") mcpCalls++;
      response
        .writeHead(200, { "content-type": "application/json" })
        .end(JSON.stringify({ jsonrpc: "2.0", id: body.id, result }));
    })().catch(() => {
      response.writeHead(500).end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = "http://127.0.0.1:" + (server.address() as { port: number }).port;
  let sessionId: string | undefined;
  const until = async <T>(read: () => Promise<T>, accepts: (value: T) => boolean): Promise<T> => {
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      const value = await read();
      if (accepts(value)) return value;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error("MCP smoke state did not settle");
  };
  try {
    const models = await call<{ config: { providers?: Record<string, unknown> }; version: string }>("modelsConfig.get");
    await call("modelsConfig.set", {
      expectedVersion: models.version,
      config: {
        ...models.config,
        providers: {
          ...models.config.providers,
          "mcp-e2e": {
            baseUrl: base + "/v1",
            api: "openai-completions",
            models: [
              {
                id: "fixture",
                name: "MCP fixture",
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
    await call("auth.setApiKey", { provider: "mcp-e2e", key: "isolated-fixture-key" });
    const created = await call<{ sessionId: string }>("agent.new", {
      type: "ensure_session",
      cwd: process.cwd(),
      provider: "mcp-e2e",
      modelId: "fixture",
    });
    sessionId = created.sessionId;
    await call("agent.command", { sessionId, command: { type: "prompt", message: "MCP_BOOTSTRAP", clientRunId: 901 } });
    await until(
      () => call<{ state?: { isPromptRunning?: boolean; isStreaming?: boolean } }>("agent.state", { sessionId }),
      (state) => !state.state?.isPromptRunning && !state.state?.isStreaming,
    );
    await call("sessions.rename", { id: sessionId, name: "MCP smoke session" });
    const configureCode =
      'async (url) => {\n    const until = async (read) => {\n        const deadline = Date.now() + 12000;\n        while (Date.now() < deadline) {\n            const value = read();\n            if (value)\n                return value;\n            await new Promise((resolve) => setTimeout(resolve, 25));\n        }\n        throw new Error("MCP UI element did not appear: " + document.body.innerText.slice(-3000)+" ROWS:"+Array.from(document.querySelectorAll(".mcp-tool-row")).map(row=>row.textContent+":"+row.querySelector("input")?.checked+":"+row.querySelector("input")?.disabled).join(";"));\n    };\n    const find = (text) => Array.from(document.querySelectorAll("button")).find((button) => [text, ({"Add server":"新增服务器","Save configuration":"保存配置","Test connection":"测试连接"})[text]].includes(button.textContent?.trim()));\n    const set = (element, value) => {\n        if (!element)\n            throw new Error("Missing MCP input");\n        const prototype = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;\n        Object.getOwnPropertyDescriptor(prototype, "value").set.call(element, value);\n        element.dispatchEvent(new Event("input", { bubbles: true }));\n    };\n    (await until(() => Array.from(document.querySelectorAll("button[aria-label]")).find((button) => button.getAttribute("aria-label")?.includes("MCP smoke session")))).click();\n    (await until(() => document.querySelector(\'button[title="Settings"],button[title="设置"]\'))).click();\n    (await until(() => find("MCP"))).click();\n    (await until(() => find("Add server"))).click();\n    const editor = (await until(() => document.querySelector(".mcp-editor")));\n    set(editor.querySelector(\'input[id$="-name"]\'), "smoke");\n    editor.querySelector(\'input[type="checkbox"]\').click();\n    const textarea = (await until(() => editor.querySelector("textarea")));\n    set(textarea, JSON.stringify({ url, exposure: "codemode" }));\n    (await until(() => find("Save configuration"))).click();\n    await until(() => !document.querySelector(".mcp-editor"));\n    (await until(() => find("Test connection"))).click();\n    await until(() => document.querySelector("[data-mcp-config]")?.textContent?.includes("临时连接") || document.querySelector("[data-mcp-config]")?.textContent?.includes("temporary connection"));\n    return true;\n}';
    await window.webContents.executeJavaScript("(" + configureCode + ")(" + JSON.stringify(base + "/mcp") + ")");
    await captureSettingsReferences(window);
    await runMcpPresentationChecks(window);
    await until(
      () => call<McpPanelSnapshot>("mcp.snapshot", { sessionId }),
      (value) => value.tools.some((tool) => tool.name === "mcp__smoke__echo" && tool.callable),
    );
    await window.webContents.executeJavaScript(
      `Array.from(document.querySelectorAll('[role="dialog"] button[aria-label]')).find(button=>['Close','关闭','關閉'].includes(button.getAttribute('aria-label')))?.click()`,
    );
    await call("agent.command", { sessionId, command: { type: "prompt", message: "MCP_EXECUTE", clientRunId: 902 } });
    await window.webContents.executeJavaScript(`(async()=>{
      const deadline=Date.now()+10000;
      while(Date.now()<deadline){
        const dialog=Array.from(document.querySelectorAll('[role="dialog"]')).find(dialog=>dialog.textContent.includes('smoke') && dialog.textContent.includes('echo'));
        if(dialog) return true;
        await new Promise(resolve=>setTimeout(resolve,25));
      }
      throw new Error('First-use MCP authorization dialog did not appear');
    })()`);
    if (process.env.PI_DESKTOP_MCP_PRESENTATION_DIR) {
      const { writeFile } = await import("node:fs/promises");
      const { default: path } = await import("node:path");
      await writeFile(
        path.join(process.env.PI_DESKTOP_MCP_PRESENTATION_DIR, "permission.png"),
        (await window.webContents.capturePage()).toPNG(),
      );
    }
    await window.webContents.executeJavaScript(
      `Array.from(document.querySelectorAll('[role="dialog"] button')).find(button=>['Allow for this session','允许当前会话使用','允許目前會話使用','Confirm','确认','確認'].includes(button.textContent.trim())).click()`,
    );

    await until(
      () => call<{ state?: { isPromptRunning?: boolean; isStreaming?: boolean } }>("agent.state", { sessionId }),
      (state) => !state.state?.isPromptRunning && !state.state?.isStreaming,
    );
    const history = await call<{
      records: Array<{ executionId: string; toolName: string; status: string; result?: { value?: unknown } }>;
    }>("sessions.executions", { id: sessionId, includeContent: true });
    const child = history.records.find((record) => record.toolName === "mcp__smoke__echo");
    if (mcpCalls !== 1 || child?.status !== "succeeded" || !JSON.stringify(child.result).includes("MCP_ORIGINAL"))
      throw new Error("MCP real Agent call or original execution history failed");
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("MCP history reload timed out")), 15000);
      window.webContents.once("did-finish-load", () => {
        clearTimeout(timeout);
        resolve();
      });
      window.webContents.reload();
    });
    await window.webContents.executeJavaScript(`(async () => {
      const deadline = Date.now() + 10000;
      let selected = false;
      while (Date.now() < deadline) {
        const sidebar = Array.from(document.querySelectorAll('button[aria-label]')).find(button => button.getAttribute('aria-label')?.includes('MCP smoke session'));
        if (sidebar && !selected) { sidebar.click(); selected = true; }
        const details = Array.from(document.querySelectorAll('button[title]')).find(button => ['Expand process details', '展开过程详情', '展開過程詳情'].includes(button.title));
        details?.click();
        const text = document.body.innerText;
        if (selected && text.includes('MCP_E2E_DONE') && text.includes('codemode') && text.includes('MCP_ORIGINAL')) {
          if (document.querySelector('[data-execution-history], .mcp-session-menu'))
            throw new Error('Duplicate MCP controls or execution history appeared below the conversation');
          return true;
        }
        await new Promise(resolve => setTimeout(resolve, 25));
      }
      throw new Error('MCP tool call and result did not appear in the reloaded conversation');
    })()`);
    const restored = await call<typeof history>("sessions.executions", { id: sessionId, includeContent: true });
    const restoredChild = restored.records.find((record) => record.executionId === child.executionId);
    if (restoredChild?.status !== "succeeded" || !JSON.stringify(restoredChild.result).includes("MCP_ORIGINAL"))
      throw new Error("Removing the history panel affected persisted MCP execution content");
    if (process.env.PI_DESKTOP_MCP_PRESENTATION_DIR) {
      await window.webContents.executeJavaScript(
        "Promise.all(Array.from(document.querySelectorAll('.chat-conversation-enter')).flatMap(element => element.getAnimations()).map(animation => animation.finished.catch(() => undefined)))",
      );
      const { writeFile } = await import("node:fs/promises");
      const { default: path } = await import("node:path");
      await writeFile(
        path.join(process.env.PI_DESKTOP_MCP_PRESENTATION_DIR, "conversation.png"),
        (await window.webContents.capturePage()).toPNG(),
      );
    }
    await call("agent.command", { sessionId, command: { type: "prompt", message: "/mcp", clientRunId: 903 } });
    await window.webContents.executeJavaScript(`(async () => {
      const deadline = Date.now() + 10000;
      while (Date.now() < deadline) {
        if (document.querySelector('[role="dialog"] [data-mcp-config] .mcp-tool-row')) return true;
        await new Promise(resolve => setTimeout(resolve, 25));
      }
      throw new Error('/mcp did not open the unified settings page with session tool permissions');
    })()`);
  } finally {
    if (sessionId) await call("sessions.delete", { id: sessionId, force: true }).catch(() => undefined);
    const mcp = await call<{ revision: string; entries: Array<{ name: string }> }>("mcp.config.get", {
      scope: "global",
    });
    if (mcp.entries.some((entry) => entry.name === "smoke"))
      await call("mcp.config.remove", { scope: "global", name: "smoke", expectedRevision: mcp.revision });
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}
