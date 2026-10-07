import type { InlineExtension } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { SessionToolPolicy } from "../session-tool-policy";
import { peekMcpService } from "./runtime";
import { readLegacyMcpEvidence } from "./legacy-permissions";
import type { SessionExecutionHistory } from "../session-execution-history";
import {
  getDesktopSessionToolNames,
  setDesktopSessionToolNames,
  setDesktopSessionMcpExecutionTools,
  getDesktopSessionMcpDeclarations,
  setDesktopSessionMcpDeclarations,
  getDefaultStore,
} from "../session-tool-store";

export function desktopMcpExtensions(
  policy: SessionToolPolicy,
  isRunning: () => boolean,
  history?: SessionExecutionHistory,
): InlineExtension[] {
  const service = peekMcpService();
  if (!service) return [];
  policy.setMcpAuthorizer((name, input, ctx, valid) =>
    service.requestAuthorization(ctx.sessionManager.getSessionId(), name, input, ctx, valid),
  );
  policy.setMcpPreparation((name, input, ctx, callId) =>
    service.prepareToolCall(ctx.sessionManager.getSessionId(), name, input, callId, ctx.signal),
  );
  return [
    {
      name: "pi-desktop-mcp-status",
      hidden: true,
      factory: (pi) => {
        pi.on("session_start", (_event, ctx) => {
          const disabled = pi.getSettings().extensions?.includes("-builtin:mcp");
          service.observeInactive(
            ctx.sessionManager.getSessionId(),
            disabled
              ? "disabled"
              : pi.getCommands().some((command) => command.name === "mcp")
                ? "replaced"
                : "unavailable",
          );
        });
        pi.on("session_shutdown", async (_event, ctx) => {
          await service.detach(ctx.sessionManager.getSessionId());
        });
      },
    },
    {
      name: "mcp",
      builtin: true,
      replaceable: true,
      factory: (pi) => {
        pi.registerCommand("mcp", {
          description: "Manage MCP servers in Desktop Settings",
          handler: async (_args, ctx) => {
            if (ctx.hasUI) service.requestSettings(ctx.sessionManager.getSessionId());
          },
        });
        const parameters = Type.Object({ server: Type.Optional(Type.String()), cursor: Type.Optional(Type.String()) });
        for (const [name, templates] of [
          ["list_mcp_resources", false],
          ["list_mcp_resource_templates", true],
        ] as const)
          pi.registerTool({
            name,
            label: name,
            description: "List ordinary MCP resources available from a connected server",
            parameters,
            execute: async (_id, params, _signal, _update, ctx) => {
              const id = ctx.sessionManager.getSessionId(),
                names = service
                  .snapshot(id)
                  .filter((entry) => entry.state === "connected" && (!params.server || entry.name === params.server))
                  .map((entry) => entry.name);
              const pages = await Promise.all(
                names.map(async (server) => ({
                  server,
                  page: await service.resources(
                    id,
                    server,
                    templates ? undefined : params.cursor,
                    templates ? params.cursor : undefined,
                    _signal,
                  ),
                })),
              );
              return {
                content: [
                  {
                    type: "text",
                    text: JSON.stringify(
                      pages.map(({ server, page }) => ({
                        server,
                        resources: templates ? page.templates : page.resources,
                        nextCursor: templates ? page.nextTemplateCursor : page.nextCursor,
                      })),
                    ),
                  },
                ],
                details: undefined,
              };
            },
          });
        pi.registerTool({
          name: "read_mcp_resource",
          label: "Read MCP resource",
          description: "Read a resource through the selected server's granted resource tool",
          parameters: Type.Object({ server: Type.String(), uri: Type.String() }),
          execute: async (_id, params, _signal, _update, ctx) => {
            const tool = service
              .tools(ctx.sessionManager.getSessionId())
              .find((entry) => entry.server === params.server && entry.resource);
            if (!tool) throw new Error("MCP_RESOURCE_UNAVAILABLE");
            return (await ctx.executeTool(tool.name, { uri: params.uri })).result;
          },
        });
        pi.on("session_start", async (_event, ctx) => {
          const id = ctx.sessionManager.getSessionId(),
            store = getDefaultStore();
          policy.setMcpIdentityGuard((name) => store.mcpIdentityMatches(id, name));
          const evidence = await readLegacyMcpEvidence(
            ctx.sessionManager.getEntries(),
            store.unverifiedMcpTools(id),
            store.mcpUpdatedAt(id),
            history,
          );
          await service.attach({
            pi,
            ctx,
            isEmpty: () => policy.isEmpty(),
            isRunning,
            isAllowed: (name) => policy.isAllowed(name),
            catalog: (tools) => {
              store.observeMcpTools(id, tools, evidence);
              const explicit = store.getMcpExecution(id) ?? store.getExecution(id);
              policy.setMcpExecution(
                explicit ?? (store.get(id) ?? []).filter((name) => pi.getActiveTools().includes(name)),
              );
            },
            declarations: () => getDesktopSessionMcpDeclarations(ctx.sessionManager.getSessionId()),
            orchestration: () => getDefaultStore().getOrchestration(ctx.sessionManager.getSessionId()),
            setDeclarations: (names) => {
              const id = ctx.sessionManager.getSessionId();
              if (getDesktopSessionToolNames(id) === undefined) setDesktopSessionToolNames(id, pi.getActiveTools());
              setDesktopSessionMcpDeclarations(id, names);
            },
            setGrants: (names) => {
              const id = ctx.sessionManager.getSessionId();
              if (getDesktopSessionToolNames(id) === undefined)
                setDesktopSessionToolNames(
                  id,
                  policy
                    .describe()
                    .filter((tool) => tool.active)
                    .map((tool) => tool.name),
                );
              setDesktopSessionMcpExecutionTools(id, names);
              policy.setMcpExecution(names);
            },
          });
        });
        pi.on("mcp_servers_change", async (_event, ctx) => {
          await service.reconcile(ctx.sessionManager.getSessionId());
        });
        pi.on("session_shutdown", async (_event, ctx) => {
          await service.detach(ctx.sessionManager.getSessionId());
          getDefaultStore().forgetMcpCatalog(ctx.sessionManager.getSessionId());
        });
        pi.on("tool_result", (event, ctx) => {
          const notice = service.takeDiscoveryNotice(ctx.sessionManager.getSessionId(), event.toolCallId);
          if (notice) return { content: [...event.content, { type: "text" as const, text: notice }] };
        });
        pi.on("before_agent_start", async (event, ctx) => {
          service.resetPermissionRequests(ctx.sessionManager.getSessionId());
          const section = await service.preparePrompt(ctx.sessionManager.getSessionId(), ctx.signal);
          if (section) event.systemPromptOptions.sections.mcp_servers = section;
          else delete event.systemPromptOptions.sections.mcp_servers;
        });
      },
    },
  ];
}
