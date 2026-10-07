import { createHash } from "node:crypto";
import { mcpToolIdentity, type McpToolIdentity, type NamedMcpTool } from "../../shared/mcp-tool-identity";

function baseName(tool: McpToolIdentity): string {
  return `mcp__${tool.server}__${tool.resource ? "read_resource" : tool.tool}`.replace(/[^A-Za-z0-9_]/gu, "_");
}
function hashedName(tool: McpToolIdentity): string {
  const identity = `${tool.server}\0${tool.resource ? "__read_resource\0resource" : tool.tool}`;
  return `${baseName(tool).slice(0, 55)}_${createHash("sha256").update(identity).digest("hex").slice(0, 8)}`;
}

/** Retain past identities so a disappearing tool can never donate its old name to another tool. */
export class McpToolNames {
  private readonly identities = new Map<string, McpToolIdentity>();
  private readonly hashed = new Set<string>();
  add(tools: readonly McpToolIdentity[]): void {
    for (const tool of tools) this.identities.set(mcpToolIdentity(tool), { ...tool });
    if (this.identities.size > 10000)
      throw new Error("MCP catalog history exceeds the registry budget; reload this session");
  }
  resolve(reserved: ReadonlySet<string> = new Set()): Map<string, NamedMcpTool> {
    const bases = new Map<string, number>();
    for (const tool of this.identities.values()) bases.set(baseName(tool), (bases.get(baseName(tool)) ?? 0) + 1);
    for (const [identity, tool] of this.identities)
      if (baseName(tool).length > 64 || bases.get(baseName(tool))! > 1 || reserved.has(baseName(tool)))
        this.hashed.add(identity);
    const result = new Map<string, NamedMcpTool>();
    // A literal tool name may itself equal somebody else's generated hash. Hash both; never overwrite.
    for (let pass = 0; pass <= this.identities.size; pass++) {
      result.clear();
      const used = new Map<string, string>();
      let retry = false;
      for (const [identity, tool] of this.identities) {
        const name = this.hashed.has(identity) ? hashedName(tool) : baseName(tool);
        const other = used.get(name);
        if (reserved.has(name) || other !== undefined) {
          if (this.hashed.has(identity) && (other === undefined || this.hashed.has(other)))
            throw new Error("MCP tool name hash collision: " + name);
          this.hashed.add(identity);
          if (other !== undefined) this.hashed.add(other);
          retry = true;
        }
        used.set(name, identity);
        result.set(identity, { ...tool, name });
      }
      if (!retry) return result;
    }
    throw new Error("MCP tool names could not be resolved");
  }
}

function legacyNames(server: string, tool: string): string[] {
  const base = `mcp__${server}__${tool}`.replace(/[^A-Za-z0-9_-]/gu, "_");
  const hash = createHash("sha256").update(`${server}\0${tool}`).digest("hex").slice(0, 8);
  return [...(base.length <= 64 ? [base] : []), `${base.slice(0, 55)}_${hash}`];
}

/** Read-only evidence: unexecuted or compacted legacy grants without raw identity need new approval. */
export function legacyMcpIdentityEvidence(entries: readonly unknown[], updatedAt?: string): Record<string, string> {
  const proven = new Map<string, string | null>();
  const recent = new Set<string>();
  const cutoff = Date.parse(updatedAt ?? "") || 0;
  for (const value of entries) {
    if (!value || typeof value !== "object") continue;
    const entry = value as {
      type?: string;
      timestamp?: string;
      message?: { role?: string; toolName?: string; details?: { mcp?: McpToolIdentity } };
    };
    const message = entry.message,
      detail = message?.details?.mcp as (McpToolIdentity & { tool?: unknown }) | undefined;
    if (
      entry.type !== "message" ||
      message?.role !== "toolResult" ||
      typeof message.toolName !== "string" ||
      !detail ||
      typeof detail.server !== "string" ||
      typeof detail.tool !== "string" ||
      !/^[A-Za-z0-9_.-]{1,128}$/u.test(detail.server) ||
      !detail.tool.length ||
      detail.tool.length > 512 ||
      !legacyNames(detail.server, detail.tool).includes(message.toolName)
    )
      continue;
    // All observed owners count for ambiguity, even observations older than the latest permission edit.
    const identity = mcpToolIdentity(detail);
    if ((Date.parse(entry.timestamp ?? "") || 0) >= cutoff) recent.add(message.toolName);
    const old = proven.get(message.toolName);
    if (old !== undefined && old !== identity) proven.set(message.toolName, null);
    else if (old === undefined || (Date.parse(entry.timestamp ?? "") || 0) >= cutoff)
      proven.set(message.toolName, identity);
  }
  // A proof must be from an execution after the last edit, and may not have any competing owner.
  return Object.fromEntries([...proven].filter(([name, identity]) => identity !== null && recent.has(name))) as Record<
    string,
    string
  >;
}
