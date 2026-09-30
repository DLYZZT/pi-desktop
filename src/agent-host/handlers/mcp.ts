import type { ApiHandler } from "../../contract/rpc";
import type { McpTarget } from "../../contract/mcp";
import { RpcError } from "../../contract/types";
import { assertPathAllowed } from "../path-authorization";
import { validateExistingDirectory } from "../directory-validation";
import type { McpService } from "../mcp/service";
import { McpResourcePreviews } from "../mcp/resource-previews";

export function createMcpHandlers(service: McpService) {
  const cwd = async (value?: string) => {
    if (value === undefined) return;
    const checked = validateExistingDirectory(value);
    if (!checked.ok) throw new RpcError({ code: "BAD_REQUEST", message: checked.error });
    await assertPathAllowed(checked.path);
  };
  const target = async (value: McpTarget) => {
    if (typeof value.name !== "string" || !value.name)
      throw new RpcError({ code: "BAD_REQUEST", message: "MCP server name is required" });
    await cwd(value.cwd);
    return value;
  };
  const previews = new McpResourcePreviews();
  service.onShutdown(() => previews.dispose());
  return {
    "mcp.config.get": async (params) => {
      await cwd(params.cwd);
      return service.config.snapshot(params.scope, params.cwd);
    },
    "mcp.config.upsert": async (params) => {
      await cwd(params.cwd);
      const saved = await service.config.upsert(
        params.scope,
        params.cwd,
        params.name,
        params.config,
        params.expectedRevision,
      );
      await service.changed(params.scope, params.cwd);
      return saved;
    },
    "mcp.config.remove": async (params) => {
      await cwd(params.cwd);
      const saved = await service.config.remove(params.scope, params.cwd, params.name, params.expectedRevision);
      await service.changed(params.scope, params.cwd);
      return saved;
    },
    "mcp.import.preview": async (params) => {
      await cwd(params.cwd);
      return service.config.preflight(params.scope, params.cwd, params.json);
    },
    "mcp.import.apply": async (params) => {
      await cwd(params.cwd);
      const saved = await service.config.import(params.scope, params.cwd, params.json, params.expectedRevision);
      await service.changed(params.scope, params.cwd);
      return saved;
    },
    "mcp.snapshot": async ({ sessionId }) => service.panel(sessionId),
    "mcp.probe": async (params) => {
      await target(params);
      if (!/^[a-zA-Z0-9_-]{1,128}$/u.test(params.requestId))
        throw new RpcError({ code: "BAD_REQUEST", message: "Invalid MCP probe ID" });
      return service.probe(params, params.requestId);
    },
    "mcp.probe.cancel": async ({ requestId }) => {
      await service.cancelProbe(requestId);
      return { ok: true as const };
    },
    "mcp.reconnect": async ({ sessionId, name }) => {
      await service.reconnect(sessionId, name);
      return service.panel(sessionId);
    },
    "mcp.grants": async ({ sessionId, toolNames }) => service.grant(sessionId, toolNames),
    "mcp.declarations": async ({ sessionId, toolNames }) => service.declare(sessionId, toolNames),
    "mcp.extension.update": async ({ sessionId, name, config, expectedRevision }) => {
      await service.updateExtension(sessionId, name, config, expectedRevision);
      return service.panel(sessionId);
    },
    "mcp.resources": async (params) => {
      await target(params);
      return service.preview(params, async (connection) => {
        const [resources, templates] = await Promise.all([
          connection.client.serverCapabilities?.resources
            ? connection.client.listResourcesPage(params.cursor)
            : Promise.resolve({ resources: [] }),
          connection.client.serverCapabilities?.resources
            ? connection.client.listResourceTemplatesPage(params.templateCursor)
            : Promise.resolve({ resourceTemplates: [] }),
        ]);
        return {
          resources: resources.resources.filter(
            (item) => !item.uri.startsWith("ui://") && !item.mimeType?.includes("profile=mcp-app"),
          ),
          templates: templates.resourceTemplates.map((item) => ({ ...item, uri: item.uriTemplate })),
          nextCursor: "nextCursor" in resources ? resources.nextCursor : undefined,
          nextTemplateCursor: "nextCursor" in templates ? templates.nextCursor : undefined,
        };
      });
    },
    "mcp.resource.read": async (params) => {
      await target(params);
      if (typeof params.uri !== "string" || params.uri.length > 8192 || params.uri.startsWith("ui://"))
        throw new RpcError({ code: "BAD_REQUEST", message: "Unsupported MCP resource URI" });
      const content = await service.preview(params, (connection) => connection.client.readResource(params.uri));
      if (content.contents.some((item) => item.mimeType?.includes("profile=mcp-app")))
        throw new RpcError({ code: "UNSUPPORTED", message: "MCP Apps are not supported" });
      const payload = await previews.payload(content);
      if (!payload.complete)
        throw new RpcError({ code: "TOO_LARGE", message: payload.reason ?? "MCP resource exceeds the read budget" });
      return payload.ref
        ? { preview: payload.preview, hash: payload.ref.hash, bytes: payload.ref.bytes }
        : { content: payload.value };
    },
    "mcp.resource.content": async ({ hash, offset }) => previews.content(hash, offset),
    "mcp.oauth.start": async (params) => {
      await target(params);
      const entry = await service.target(params);
      return service.login.start({
        name: params.name,
        sessionId: params.sessionId ?? `settings-${params.scope ?? "global"}-${params.cwd ?? "global"}`,
        cwd: entry.cwd,
        trusted: entry.trusted,
        config: entry.config,
      });
    },
    "mcp.oauth.get": async ({ requestId }) => service.login.get(requestId),
    "mcp.oauth.submit": async ({ requestId, callbackUrl }) => service.login.submit(requestId, callbackUrl),
    "mcp.oauth.cancel": async ({ requestId }) => service.login.cancel(requestId),
    "mcp.oauth.logout": async (params) => {
      await target(params);
      const entry = await service.target(params);
      if (!entry.config.url) throw new RpcError({ code: "BAD_REQUEST", message: "OAuth requires HTTP MCP" });
      await service.credentials.remove(entry.config.url);
      if (params.sessionId) await service.reconnect(params.sessionId, params.name);
      return { ok: true as const };
    },
  } satisfies Pick<ApiHandler, `mcp.${string}` & keyof ApiHandler>;
}
