import { createInterface } from "node:readline";

// Isolated protocol endpoint for --validate-packaged-startup. It never reads user data or executes effects.
for await (const line of createInterface({ input: process.stdin })) {
  const request = JSON.parse(line) as { id?: string | number; method: string; params?: Record<string, unknown> };
  if (request.id === undefined) continue;
  let result: unknown;
  if (request.method === "initialize")
    result = {
      protocolVersion: request.params?.protocolVersion,
      capabilities: { tools: {} },
      serverInfo: { name: "runtime-probe", version: "1" },
    };
  else if (request.method === "tools/list")
    result = {
      tools: [
        { name: "echo", inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] } },
        { name: "wait", inputSchema: { type: "object", properties: {} } },
      ],
    };
  else if (request.method === "tools/call") {
    if (request.params?.name === "wait") {
      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/runtime/wait" }) + "\n");
      continue;
    }
    const text = (request.params?.arguments as { text: string }).text;
    result = { content: [{ type: "text", text }], structuredContent: { original: text } };
  } else result = {};
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }) + "\n");
}
