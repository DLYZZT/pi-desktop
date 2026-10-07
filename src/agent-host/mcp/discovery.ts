import type { McpConnection } from "./connection";
import type { McpServerConfig } from "../../contract/mcp";
import { canonicalMcpExposure } from "../../shared/mcp-exposure";
import { mcpNamespace } from "./oauth-identity";

export function mcpExposures(config: McpServerConfig): Set<string> {
  return new Set(
    [config.exposure ?? "codemode", ...Object.values(config.toolExposure ?? {})].map(canonicalMcpExposure),
  );
}
export function neededMcpServers(
  connections: readonly McpConnection[],
  toolName: string,
  input: unknown,
): McpConnection[] {
  const params = input && typeof input === "object" ? (input as { code?: unknown; server?: unknown }) : {};
  const enabled = connections.filter((connection) => connection.config.enabled !== false);
  if (["list_mcp_resources", "list_mcp_resource_templates", "read_mcp_resource"].includes(toolName))
    return enabled.filter(
      (connection) => typeof params.server !== "string" || params.server === connection.snapshot.name,
    );
  if (toolName === "tool_search") return enabled;
  if (toolName !== "codemode" || typeof params.code !== "string") return [];
  const code = params.code;
  if (/\b(searchTools|describeNamespace|describeTool|ALL_TOOLS)\b|\btools\s*\[/u.test(code)) return enabled;
  return enabled.filter((connection) => code.includes(mcpNamespace(connection.snapshot.name).slice(0, 55)));
}

/** Abortable and bounded, including transports whose initialization ignores the caller's signal. */
export async function waitForMcpConnections(
  connections: readonly McpConnection[],
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  const pending = () =>
    connections.some((connection) => ["not-started", "connecting"].includes(connection.snapshot.state));
  while (pending() && Date.now() < deadline) {
    signal?.throwIfAborted();
    await new Promise<void>((resolve, reject) => {
      const done = () => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
        resolve();
      };
      const abort = () => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
        reject(signal!.reason);
      };
      const timer = setTimeout(done, Math.min(25, Math.max(1, deadline - Date.now())));
      signal?.addEventListener("abort", abort, { once: true });
    });
  }
  signal?.throwIfAborted();
}

export function mcpAvailabilityNotice(connections: readonly McpConnection[]): string | undefined {
  const unavailable = connections.filter((connection) => connection.snapshot.state !== "connected");
  if (!unavailable.length) return;
  return (
    "MCP catalog is incomplete: " +
    unavailable
      .slice(0, 24)
      .map((connection) => `${mcpNamespace(connection.snapshot.name)} (${connection.snapshot.state})`)
      .join(", ") +
    ". An empty search is not proof that these servers have no tools. Retry after connection or sign-in completes."
  );
}

/** Only bounded configuration summaries enter the prompt. Server instructions remain namespace data. */
export function mcpServersSection(
  connections: readonly McpConnection[],
  callers: ReadonlySet<string>,
): string | undefined {
  const lines: string[] = [
    "MCP server metadata. Discover tools before calling them; discovery never grants execution permission.",
  ];
  for (const connection of [...connections].sort((a, b) => a.snapshot.name.localeCompare(b.snapshot.name))) {
    if (connection.config.enabled === false) continue;
    const exposures = mcpExposures(connection.config);
    const modes: string[] = [];
    if (exposures.has("codemode") && callers.has("codemode")) modes.push("codemode");
    if (exposures.has("deferred") && callers.has("tool_search")) modes.push("tool_search");
    if (exposures.has("direct") && connection.snapshot.state !== "connected") modes.push("direct tools pending");
    if (!modes.length) continue;
    const summary = connection.config.description?.replace(/[\r\n\t]+/gu, " ").slice(0, 250);
    const quoted = summary
      ? " " +
        JSON.stringify(summary).replace(
          /[<>&]/gu,
          (char) => ({ "<": "\\u003c", ">": "\\u003e", "&": "\\u0026" })[char]!,
        )
      : "";
    const line = `- ${mcpNamespace(connection.snapshot.name)} (${modes.join(", ")}; ${connection.snapshot.state})${quoted}`;
    if ([...lines, line].join("\n").length > 3900) {
      lines.push("Additional configured servers can be discovered with searchTools().");
      break;
    }
    lines.push(line);
  }
  return lines.length > 1 ? lines.join("\n") : undefined;
}
