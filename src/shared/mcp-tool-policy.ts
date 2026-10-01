const MCP_ENTRY_TOOLS = new Set(["list_mcp_resources", "list_mcp_resource_templates", "read_mcp_resource"]);
export function isMcpManagedTool(name: string): boolean {
  return name.startsWith("mcp__") || MCP_ENTRY_TOOLS.has(name);
}
