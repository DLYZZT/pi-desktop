/** Persist raw identities separately from names exposed to models. */
export interface McpToolIdentity {
  server: string;
  tool: string;
  resource?: boolean;
}
export interface NamedMcpTool extends McpToolIdentity {
  name: string;
}
export function mcpToolIdentity(value: McpToolIdentity): string {
  return JSON.stringify([value.server, value.tool, value.resource === true]);
}
export function validMcpToolIdentity(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 4096) return false;
  try {
    const parts = JSON.parse(value);
    return (
      Array.isArray(parts) &&
      parts.length === 3 &&
      typeof parts[0] === "string" &&
      /^[A-Za-z0-9_.-]{1,128}$/u.test(parts[0]) &&
      typeof parts[1] === "string" &&
      parts[1].length > 0 &&
      parts[1].length <= 512 &&
      typeof parts[2] === "boolean"
    );
  } catch {
    return false;
  }
}
