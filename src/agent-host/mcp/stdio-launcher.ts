import { createInterface } from "node:readline";
import { StdioTransport, parseJsonRpcMessage } from "@earendil-works/pi-mcp";

// Runs inside a Windows Job. Cross-platform command resolution belongs to the public MCP stdio transport.
const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
let transport: StdioTransport | undefined;
process.once("SIGTERM", () => {
  void transport?.close().finally(() => process.exit(0));
});
try {
  for await (const line of lines) {
    if (!transport) {
      if (Buffer.byteLength(line) > 512 * 1024) throw new Error("MCP launch configuration exceeds its budget");
      const config = JSON.parse(line) as { command: string; args: string[]; cwd: string; env: Record<string, string> };
      const env = { ...config.env };
      delete env.ELECTRON_RUN_AS_NODE;
      transport = new StdioTransport({
        ...config,
        env,
        inheritEnv: false,
        onStderr: (text) => process.stderr.write(text),
      });
      transport.onMessage((message) => process.stdout.write(JSON.stringify(message) + "\n"));
      transport.onError(() => {
        process.stderr.write("MCP stdio transport error\n");
        process.exit(1);
      });
      transport.onClose(() => process.exit(0));
      await transport.start();
    } else {
      if (Buffer.byteLength(line) > 16 * 1024 * 1024) throw new Error("MCP request exceeds its budget");
      await transport.send(parseJsonRpcMessage(JSON.parse(line)));
    }
  }
  await transport?.close();
} catch {
  process.stderr.write("MCP protocol launcher failed\n");
  await transport?.close();
  process.exitCode = 1;
}
