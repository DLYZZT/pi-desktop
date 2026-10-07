import type { RpcServer } from "../../contract/rpc";
import { McpService } from "./service";
import { getSharedModelRuntime } from "../model-runtime";
let service: McpService | undefined;
export function initializeMcpService(server: Pick<RpcServer, "emit">): McpService {
  service ??= new McpService({
    connection: {
      providerToken: async (provider) => (await (await getSharedModelRuntime()).getAuth(provider))?.auth.apiKey,
    },
    changed: (sessionId, instances) => server.emit("mcp.changed", sessionId, { sessionId, instances }),
    oauth: { updated: (snapshot) => server.emit("mcp.oauth", snapshot.sessionId, snapshot) },
    settings: (sessionId) => server.emit("mcp.settings", sessionId, { sessionId }),
  });
  return service;
}
export function getMcpService(): McpService {
  if (!service) throw new Error("MCP service is not initialized");
  return service;
}
export function peekMcpService(): McpService | undefined {
  return service;
}
