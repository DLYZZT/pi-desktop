import { randomUUID } from "node:crypto";
import { defineTool, type ExtensionContext, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  HERDR_AGENT_PROMPT_MAX_BYTES,
  HERDR_AGENT_ALIAS_PATTERN,
  HERDR_AGENT_WAIT_MAX_MS,
  HERDR_PANE_READ_MAX_BYTES,
  HERDR_SAFE_AGENT_KEYS,
  HERDR_STARTABLE_AGENT_KINDS,
  type HerdrAgentState,
} from "../../contract/herdr.ts";
import { getAgentSessionSource } from "../session-source.ts";
import type { ExtensionUiConfirmLocalization } from "../../shared/types.ts";
import type { HerdrBridge } from "./bridge.ts";
import { HerdrBridgeError } from "./errors.ts";
import { HERDR_TOOL_NAMES } from "./tool-names.ts";
export { HERDR_TOOL_NAMES, isHerdrToolName } from "./tool-names.ts";

type ToolContext = Pick<ExtensionContext, "sessionManager" | "hasUI" | "ui">;

const MAX_AGENT_PROMPT_CHARS = HERDR_AGENT_PROMPT_MAX_BYTES;
const MAX_AGENT_READ_BYTES = HERDR_PANE_READ_MAX_BYTES;
const MAX_LIST_PANES = 200;
const MAX_WAIT_MS = HERDR_AGENT_WAIT_MAX_MS;
const AGENT_STATES = ["blocked", "working", "done", "idle", "unknown"] as const;

const GUIDELINES = [
  "Herdr panes and agents are external persistent resources owned by Herdr, not by this Pi session.",
  "Use herdr_list before a mutating call unless you already have the exact workspace, tab, or pane id from a fresh Herdr tool result.",
  "Use herdr_agent_wait for progress instead of repeatedly polling herdr_pane_read or herdr_list.",
];

const workspaceId = Type.String({
  minLength: 1,
  maxLength: 256,
  description: "Exact Herdr workspace id from herdr_list; never abbreviate it",
});

const tabId = Type.String({
  minLength: 1,
  maxLength: 256,
  description: "Exact Herdr tab id from herdr_list; never abbreviate it",
});

const paneId = Type.String({
  minLength: 1,
  maxLength: 256,
  description: "Exact Herdr pane id from herdr_list; never abbreviate it",
});

const objectName = Type.String({ minLength: 1, maxLength: 160 });

function text(value: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
    details: undefined,
  };
}

function toolError(error: unknown): never {
  if (error instanceof HerdrBridgeError) throw new Error(`${error.code}: ${error.message}`);
  throw error;
}

function assertLocalTurn(ctx: ToolContext): void {
  if (getAgentSessionSource(ctx.sessionManager) !== "local") {
    throw new HerdrBridgeError("HERDR_DISABLED", "Herdr tools are unavailable for messaging-channel turns.");
  }
}

function assertReady(bridge: HerdrBridge): void {
  const runtime = bridge.getRuntime();
  if (runtime.status !== "ready") {
    throw new HerdrBridgeError("HERDR_ENDPOINT_UNAVAILABLE", "Herdr is not connected.", true);
  }
}

function withHerdr<T>(ctx: ToolContext, bridge: HerdrBridge, operation: () => T): T {
  try {
    assertLocalTurn(ctx);
    assertReady(bridge);
    return operation();
  } catch (error) {
    return toolError(error);
  }
}

async function withHerdrAsync<T>(ctx: ToolContext, bridge: HerdrBridge, operation: () => Promise<T>): Promise<T> {
  try {
    assertLocalTurn(ctx);
    assertReady(bridge);
    return await operation();
  } catch (error) {
    return toolError(error);
  }
}

async function requireDestructiveConfirmation(
  ctx: ToolContext,
  title: string,
  message: string,
  localization: ExtensionUiConfirmLocalization,
  signal?: AbortSignal,
): Promise<void> {
  if (!ctx.hasUI) {
    throw new HerdrBridgeError(
      "HERDR_CONFIRMATION_REQUIRED",
      "This Herdr close operation requires an interactive local confirmation.",
    );
  }
  const localizedUi = ctx.ui as typeof ctx.ui & {
    confirmLocalized?: (
      title: string,
      message: string,
      localization: ExtensionUiConfirmLocalization,
      opts?: { signal?: AbortSignal; timeout?: number },
    ) => Promise<boolean>;
  };
  const confirmed = localizedUi.confirmLocalized
    ? await localizedUi.confirmLocalized(title, message, localization, { signal, timeout: 120_000 })
    : await ctx.ui.confirm(title, message, { signal, timeout: 120_000 });
  if (!confirmed) throw new HerdrBridgeError("HERDR_REQUEST_CANCELLED", "The Herdr close operation was cancelled.");
}

export function herdrToolNamesForRuntime(bridge: HerdrBridge | null): string[] {
  if (!bridge) return [];
  const runtime = bridge.getRuntime();
  if (runtime.status !== "ready") return [];
  const allowed = new Set<string>(["herdr_status"]);
  if (runtime.capabilities.readOnly) {
    allowed.add("herdr_list");
    allowed.add("herdr_pane_read");
    allowed.add("herdr_agent_explain");
    allowed.add("herdr_pane_process_info");
    allowed.add("herdr_pane_wait_for_output");
  }
  if (runtime.capabilities.agentControl) {
    allowed.add("herdr_workspace_create");
    allowed.add("herdr_tab_create");
    allowed.add("herdr_tab_focus");
    allowed.add("herdr_tab_rename");
    allowed.add("herdr_pane_split");
    allowed.add("herdr_agent_start");
    allowed.add("herdr_agent_prompt");
    allowed.add("herdr_agent_wait");
    allowed.add("herdr_agent_keys");
    allowed.add("herdr_workspace_focus");
    allowed.add("herdr_workspace_rename");
    allowed.add("herdr_workspace_close");
    allowed.add("herdr_pane_focus");
    allowed.add("herdr_pane_rename");
    allowed.add("herdr_pane_close");
    allowed.add("herdr_agent_focus");
    allowed.add("herdr_agent_rename");
    allowed.add("herdr_agent_close");
  }
  return HERDR_TOOL_NAMES.filter((name) => allowed.has(name));
}

export function createHerdrToolDefinitions(ownerCwd: string, bridge: HerdrBridge): ToolDefinition[] {
  return [
    defineTool({
      name: "herdr_status",
      label: "Herdr status",
      description: "Inspect the connected Herdr runtime, protocol, session, and available control capabilities.",
      promptSnippet: "herdr_status: inspect the connected Herdr runtime and capabilities",
      promptGuidelines: GUIDELINES,
      parameters: Type.Object({}),
      executionMode: "sequential",
      async execute(_toolCallId, _input, _signal, _onUpdate, ctx) {
        return withHerdr(ctx, bridge, () => text(bridge.getRuntime()));
      },
    }),
    defineTool({
      name: "herdr_list",
      label: "list Herdr agents",
      description:
        "Refresh and list Herdr workspaces, tabs, panes, and detected agents. Results are bounded; filter by workspace or state when needed.",
      promptSnippet: "herdr_list: refresh the Herdr fleet and obtain exact pane ids",
      promptGuidelines: GUIDELINES,
      parameters: Type.Object({
        workspaceId: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
        state: Type.Optional(Type.Union(AGENT_STATES.map((state) => Type.Literal(state)))),
        limit: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_LIST_PANES })),
      }),
      executionMode: "sequential",
      async execute(_toolCallId, input, _signal, _onUpdate, ctx) {
        return withHerdrAsync(ctx, bridge, async () => {
          const fleet = await bridge.refreshSnapshot();
          const limit = input.limit ?? 100;
          const panes = fleet.panes.filter(
            (pane) =>
              (!input.workspaceId || pane.workspaceId === input.workspaceId) &&
              (!input.state || (pane.agent?.state ?? "unknown") === input.state),
          );
          const visiblePanes = panes.slice(0, limit);
          const visiblePaneIds = new Set(visiblePanes.map((pane) => pane.id));
          const workspaces = fleet.workspaces
            .filter((workspace) => !input.workspaceId || workspace.id === input.workspaceId)
            .map((workspace) => ({
              ...workspace,
              tabs: workspace.tabs
                .map((tab) => ({ ...tab, paneIds: tab.paneIds.filter((id) => visiblePaneIds.has(id)) }))
                .filter((tab) => tab.paneIds.length > 0),
            }))
            .filter((workspace) => workspace.tabs.length > 0);
          return text({
            revision: fleet.revision,
            receivedAt: fleet.receivedAt,
            stale: fleet.stale,
            focusedPaneId: fleet.focusedPaneId,
            totalMatchingPanes: panes.length,
            truncated: panes.length > visiblePanes.length,
            workspaces,
            panes: visiblePanes,
          });
        });
      },
    }),
    defineTool({
      name: "herdr_workspace_create",
      label: "create Herdr workspace",
      description:
        "Create a Herdr workspace rooted at this Pi session's project directory. The directory cannot be overridden.",
      promptSnippet: "herdr_workspace_create: create a persistent Herdr workspace for the current project",
      promptGuidelines: GUIDELINES,
      parameters: Type.Object({
        name: Type.Optional(Type.String({ minLength: 1, maxLength: 160 })),
      }),
      executionMode: "sequential",
      async execute(_toolCallId, input, _signal, _onUpdate, ctx) {
        return withHerdrAsync(ctx, bridge, async () => text(await bridge.createWorkspace(ownerCwd, input.name)));
      },
    }),
    defineTool({
      name: "herdr_tab_create",
      label: "create Herdr tab",
      description:
        "Create a tab in an exact Herdr workspace. Its root pane is fixed to this Pi session's project directory; arbitrary environment variables are unavailable.",
      promptSnippet: "herdr_tab_create: create a Herdr tab for the current project in an exact workspace",
      promptGuidelines: GUIDELINES,
      parameters: Type.Object({
        workspaceId,
        name: Type.Optional(Type.String({ minLength: 1, maxLength: 160 })),
        focus: Type.Optional(Type.Boolean({ description: "Focus the new tab; defaults to false" })),
      }),
      executionMode: "sequential",
      async execute(_toolCallId, input, _signal, _onUpdate, ctx) {
        return withHerdrAsync(ctx, bridge, async () =>
          text(await bridge.createTab(input.workspaceId, ownerCwd, input.name, input.focus ?? false)),
        );
      },
    }),
    defineTool({
      name: "herdr_tab_focus",
      label: "focus Herdr tab",
      description: "Focus an existing Herdr tab by its exact id so it becomes the active tab in its workspace.",
      promptSnippet: "herdr_tab_focus: focus an exact Herdr tab",
      promptGuidelines: GUIDELINES,
      parameters: Type.Object({ tabId }),
      executionMode: "sequential",
      async execute(_toolCallId, input, _signal, _onUpdate, ctx) {
        return withHerdrAsync(ctx, bridge, async () => text(await bridge.focusTab(input.tabId)));
      },
    }),
    defineTool({
      name: "herdr_tab_rename",
      label: "rename Herdr tab",
      description: "Rename an existing Herdr tab by its exact id.",
      promptSnippet: "herdr_tab_rename: rename an exact Herdr tab",
      promptGuidelines: GUIDELINES,
      parameters: Type.Object({
        tabId,
        name: Type.String({ minLength: 1, maxLength: 160 }),
      }),
      executionMode: "sequential",
      async execute(_toolCallId, input, _signal, _onUpdate, ctx) {
        return withHerdrAsync(ctx, bridge, async () => text(await bridge.renameTab(input.tabId, input.name)));
      },
    }),
    defineTool({
      name: "herdr_pane_split",
      label: "split Herdr pane",
      description: "Split an existing Herdr pane and return the exact id of the new persistent pane.",
      promptSnippet: "herdr_pane_split: split a Herdr pane horizontally or vertically",
      promptGuidelines: GUIDELINES,
      parameters: Type.Object({
        paneId,
        direction: Type.Union([Type.Literal("horizontal"), Type.Literal("vertical")]),
      }),
      executionMode: "sequential",
      async execute(_toolCallId, input, _signal, _onUpdate, ctx) {
        return withHerdrAsync(ctx, bridge, async () => text(await bridge.splitPane(input.paneId, input.direction)));
      },
    }),
    defineTool({
      name: "herdr_pane_read",
      label: "read Herdr pane",
      description:
        "Read a bounded, ANSI-stripped recent text window from a Herdr pane. Use for diagnosis or a final result check, not polling.",
      promptSnippet: "herdr_pane_read: read bounded recent text from a Herdr pane",
      promptGuidelines: GUIDELINES,
      parameters: Type.Object({
        paneId,
        maxBytes: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_AGENT_READ_BYTES })),
      }),
      executionMode: "sequential",
      async execute(_toolCallId, input, _signal, _onUpdate, ctx) {
        return withHerdrAsync(ctx, bridge, async () =>
          text(await bridge.readPane(input.paneId, input.maxBytes ?? 16_384)),
        );
      },
    }),
    defineTool({
      name: "herdr_agent_start",
      label: "start Herdr agent",
      description:
        "Start one supported coding agent in an existing Herdr pane. Arbitrary executable arguments are intentionally unavailable.",
      promptSnippet: "herdr_agent_start: start a supported coding agent in an exact Herdr pane",
      promptGuidelines: GUIDELINES,
      parameters: Type.Object({
        paneId,
        kind: Type.Union(HERDR_STARTABLE_AGENT_KINDS.map((kind) => Type.Literal(kind))),
      }),
      executionMode: "sequential",
      async execute(_toolCallId, input, _signal, _onUpdate, ctx) {
        return withHerdrAsync(ctx, bridge, async () => text(await bridge.startAgent(input.paneId, input.kind)));
      },
    }),
    defineTool({
      name: "herdr_agent_prompt",
      label: "prompt Herdr agent",
      description:
        "Send one natural-language prompt to the detected agent in a Herdr pane. Herdr submits it as an agent prompt, not raw terminal input.",
      promptSnippet: "herdr_agent_prompt: send a prompt to a Herdr agent by exact pane id",
      promptGuidelines: GUIDELINES,
      parameters: Type.Object({
        paneId,
        prompt: Type.String({ minLength: 1, maxLength: MAX_AGENT_PROMPT_CHARS }),
      }),
      executionMode: "sequential",
      async execute(_toolCallId, input, _signal, _onUpdate, ctx) {
        return withHerdrAsync(ctx, bridge, async () => text(await bridge.promptAgent(input.paneId, input.prompt)));
      },
    }),
    defineTool({
      name: "herdr_agent_wait",
      label: "wait for Herdr agent",
      description:
        "Wait for a Herdr agent to reach one of the requested semantic states. A timeout is reported as data, not an error.",
      promptSnippet: "herdr_agent_wait: wait without polling for a Herdr agent state change",
      promptGuidelines: GUIDELINES,
      parameters: Type.Object({
        paneId,
        states: Type.Array(Type.Union(AGENT_STATES.map((state) => Type.Literal(state))), {
          minItems: 1,
          maxItems: AGENT_STATES.length,
          uniqueItems: true,
        }),
        timeoutMs: Type.Optional(Type.Integer({ minimum: 100, maximum: MAX_WAIT_MS })),
      }),
      executionMode: "sequential",
      async execute(_toolCallId, input, signal, _onUpdate, ctx) {
        const requestId = randomUUID();
        const cancel = () => {
          try {
            bridge.cancelWait(requestId);
          } catch {
            // The wait may already have completed and removed itself.
          }
        };
        signal?.addEventListener("abort", cancel, { once: true });
        try {
          return await withHerdrAsync(ctx, bridge, async () =>
            text(
              await bridge.waitAgent(
                input.paneId,
                input.states as HerdrAgentState[],
                input.timeoutMs ?? 30_000,
                requestId,
              ),
            ),
          );
        } finally {
          signal?.removeEventListener("abort", cancel);
        }
      },
    }),
    defineTool({
      name: "herdr_agent_keys",
      label: "send Herdr agent keys",
      description:
        "Send a small allowlisted set of semantic keys to a detected Herdr agent, for example Enter, Escape, navigation, or Ctrl+C. Raw text and arbitrary chords are unavailable.",
      promptSnippet: "herdr_agent_keys: send allowlisted semantic keys to a Herdr agent",
      promptGuidelines: GUIDELINES,
      parameters: Type.Object({
        paneId,
        keys: Type.Array(Type.Union(HERDR_SAFE_AGENT_KEYS.map((key) => Type.Literal(key))), {
          minItems: 1,
          maxItems: 8,
        }),
      }),
      executionMode: "sequential",
      async execute(_toolCallId, input, _signal, _onUpdate, ctx) {
        return withHerdrAsync(ctx, bridge, async () => text(await bridge.sendAgentKeys(input.paneId, input.keys)));
      },
    }),
    defineTool({
      name: "herdr_agent_explain",
      label: "explain Herdr agent",
      description:
        "Explain the detected Agent state for an exact pane, including sanitized rule/fallback signals and whether Pi Desktop can locate a supported CLI. Terminal evidence, paths, and command lines are omitted.",
      promptSnippet:
        "herdr_agent_explain: explain blocked or unknown Agent detection without exposing raw terminal data",
      promptGuidelines: GUIDELINES,
      parameters: Type.Object({ paneId }),
      executionMode: "sequential",
      async execute(_toolCallId, input, _signal, _onUpdate, ctx) {
        return withHerdrAsync(ctx, bridge, async () => text(await bridge.explainAgent(input.paneId)));
      },
    }),
    defineTool({
      name: "herdr_pane_process_info",
      label: "inspect Herdr pane process",
      description:
        "Inspect sanitized foreground process names and Agent detection for an exact pane. PIDs, paths, argv, command lines, TTYs, and environment values are never returned.",
      promptSnippet: "herdr_pane_process_info: inspect sanitized foreground process and Agent detection metadata",
      promptGuidelines: GUIDELINES,
      parameters: Type.Object({ paneId }),
      executionMode: "sequential",
      async execute(_toolCallId, input, _signal, _onUpdate, ctx) {
        return withHerdrAsync(ctx, bridge, async () => text(await bridge.getPaneProcessInfo(input.paneId)));
      },
    }),
    defineTool({
      name: "herdr_pane_wait_for_output",
      label: "wait for Herdr pane output",
      description:
        "Wait until an exact shell pane contains a literal substring. Existing recent ANSI-stripped output is checked first; use this instead of polling pane reads.",
      promptSnippet: "herdr_pane_wait_for_output: wait for a literal substring in bounded pane output",
      promptGuidelines: GUIDELINES,
      parameters: Type.Object({
        paneId,
        text: Type.String({ minLength: 1, maxLength: 4_096 }),
        timeoutMs: Type.Optional(Type.Integer({ minimum: 100, maximum: MAX_WAIT_MS })),
      }),
      executionMode: "sequential",
      async execute(_toolCallId, input, signal, _onUpdate, ctx) {
        const requestId = randomUUID();
        const cancel = () => {
          try {
            bridge.cancelWait(requestId);
          } catch {
            // The wait may already have completed and removed itself.
          }
        };
        signal?.addEventListener("abort", cancel, { once: true });
        try {
          return await withHerdrAsync(ctx, bridge, async () =>
            text(await bridge.waitForPaneOutput(input.paneId, input.text, input.timeoutMs ?? 30_000, requestId)),
          );
        } finally {
          signal?.removeEventListener("abort", cancel);
        }
      },
    }),
    defineTool({
      name: "herdr_workspace_focus",
      label: "focus Herdr workspace",
      description: "Focus an existing Herdr workspace by its exact id.",
      promptSnippet: "herdr_workspace_focus: focus an exact persistent Herdr workspace",
      promptGuidelines: GUIDELINES,
      parameters: Type.Object({ workspaceId }),
      executionMode: "sequential",
      async execute(_toolCallId, input, _signal, _onUpdate, ctx) {
        return withHerdrAsync(ctx, bridge, async () => text(await bridge.focusWorkspace(input.workspaceId)));
      },
    }),
    defineTool({
      name: "herdr_workspace_rename",
      label: "rename Herdr workspace",
      description: "Rename an existing Herdr workspace by its exact id.",
      promptSnippet: "herdr_workspace_rename: rename an exact persistent Herdr workspace",
      promptGuidelines: GUIDELINES,
      parameters: Type.Object({ workspaceId, name: objectName }),
      executionMode: "sequential",
      async execute(_toolCallId, input, _signal, _onUpdate, ctx) {
        return withHerdrAsync(ctx, bridge, async () =>
          text(await bridge.renameWorkspace(input.workspaceId, input.name)),
        );
      },
    }),
    defineTool({
      name: "herdr_workspace_close",
      label: "close Herdr workspace",
      description:
        "Close an exact persistent Herdr workspace after an interactive local confirmation. This terminates every pane and process in that workspace.",
      promptSnippet: "herdr_workspace_close: close a workspace only after the user accepts the Pi confirmation dialog",
      promptGuidelines: GUIDELINES,
      parameters: Type.Object({ workspaceId }),
      executionMode: "sequential",
      async execute(_toolCallId, input, signal, _onUpdate, ctx) {
        return withHerdrAsync(ctx, bridge, async () => {
          const fleet = await bridge.refreshSnapshot();
          const workspace = fleet.workspaces.find((candidate) => candidate.id === input.workspaceId);
          if (!workspace)
            throw new HerdrBridgeError("HERDR_INVALID_REQUEST", "Workspace is not present in the current snapshot.");
          const paneCount = fleet.panes.filter((pane) => pane.workspaceId === workspace.id && pane.alive).length;
          await requireDestructiveConfirmation(
            ctx,
            "Close Herdr workspace",
            `Close workspace ${workspace.name ?? workspace.id}? This will terminate ${paneCount} pane(s) and all processes in them. This cannot be undone by Pi Desktop.`,
            { id: "herdr.closeWorkspace", target: workspace.name ?? workspace.id, paneCount },
            signal,
          );
          return text(await bridge.closeWorkspace(workspace.id));
        });
      },
    }),
    defineTool({
      name: "herdr_pane_focus",
      label: "focus Herdr pane",
      description: "Focus an existing Herdr pane by its exact id.",
      promptSnippet: "herdr_pane_focus: focus an exact persistent Herdr pane",
      promptGuidelines: GUIDELINES,
      parameters: Type.Object({ paneId }),
      executionMode: "sequential",
      async execute(_toolCallId, input, _signal, _onUpdate, ctx) {
        return withHerdrAsync(ctx, bridge, async () => text(await bridge.focusPane(input.paneId)));
      },
    }),
    defineTool({
      name: "herdr_pane_rename",
      label: "rename Herdr pane",
      description: "Rename an existing Herdr pane by its exact id.",
      promptSnippet: "herdr_pane_rename: rename an exact persistent Herdr pane",
      promptGuidelines: GUIDELINES,
      parameters: Type.Object({ paneId, name: objectName }),
      executionMode: "sequential",
      async execute(_toolCallId, input, _signal, _onUpdate, ctx) {
        return withHerdrAsync(ctx, bridge, async () => text(await bridge.renamePane(input.paneId, input.name)));
      },
    }),
    defineTool({
      name: "herdr_pane_close",
      label: "close Herdr pane",
      description:
        "Close an exact persistent Herdr pane after an interactive local confirmation. This terminates its shell, Agent, and other processes.",
      promptSnippet: "herdr_pane_close: close a pane only after the user accepts the Pi confirmation dialog",
      promptGuidelines: GUIDELINES,
      parameters: Type.Object({ paneId }),
      executionMode: "sequential",
      async execute(_toolCallId, input, signal, _onUpdate, ctx) {
        return withHerdrAsync(ctx, bridge, async () => {
          const fleet = await bridge.refreshSnapshot();
          const pane = fleet.panes.find((candidate) => candidate.id === input.paneId && candidate.alive);
          if (!pane) throw new HerdrBridgeError("HERDR_PANE_NOT_FOUND", "Pane is not present in the current snapshot.");
          await requireDestructiveConfirmation(
            ctx,
            "Close Herdr pane",
            `Close pane ${pane.title ?? pane.id}? This will terminate its shell, Agent, and other processes. This cannot be undone by Pi Desktop.`,
            { id: "herdr.closePane", target: pane.title ?? pane.id },
            signal,
          );
          return text(await bridge.closePane(pane.id));
        });
      },
    }),
    defineTool({
      name: "herdr_agent_focus",
      label: "focus Herdr agent",
      description: "Focus the detected Agent in an exact Herdr pane.",
      promptSnippet: "herdr_agent_focus: focus the detected Agent in an exact pane",
      promptGuidelines: GUIDELINES,
      parameters: Type.Object({ paneId }),
      executionMode: "sequential",
      async execute(_toolCallId, input, _signal, _onUpdate, ctx) {
        return withHerdrAsync(ctx, bridge, async () => text(await bridge.focusAgent(input.paneId)));
      },
    }),
    defineTool({
      name: "herdr_agent_rename",
      label: "rename Herdr agent",
      description: "Rename the detected Agent in an exact Herdr pane.",
      promptSnippet: "herdr_agent_rename: rename the detected Agent in an exact pane",
      promptGuidelines: GUIDELINES,
      parameters: Type.Object({
        paneId,
        name: Type.String({
          minLength: 1,
          maxLength: 64,
          pattern: HERDR_AGENT_ALIAS_PATTERN,
          description: "Lowercase Agent alias using letters, digits, underscores, or hyphens",
        }),
      }),
      executionMode: "sequential",
      async execute(_toolCallId, input, _signal, _onUpdate, ctx) {
        return withHerdrAsync(ctx, bridge, async () => text(await bridge.renameAgent(input.paneId, input.name)));
      },
    }),
    defineTool({
      name: "herdr_agent_close",
      label: "close Herdr agent pane",
      description:
        "Terminate a detected Herdr Agent by closing its containing pane after an interactive local confirmation. Herdr v0.8.2 has no agent.stop API, so the result explicitly reports paneClosed=true.",
      promptSnippet: "herdr_agent_close: close the Agent's pane only after the user accepts the Pi confirmation dialog",
      promptGuidelines: GUIDELINES,
      parameters: Type.Object({ paneId }),
      executionMode: "sequential",
      async execute(_toolCallId, input, signal, _onUpdate, ctx) {
        return withHerdrAsync(ctx, bridge, async () => {
          const fleet = await bridge.refreshSnapshot();
          const pane = fleet.panes.find((candidate) => candidate.id === input.paneId && candidate.alive);
          if (!pane) throw new HerdrBridgeError("HERDR_PANE_NOT_FOUND", "Pane is not present in the current snapshot.");
          if (!pane.agent) throw new HerdrBridgeError("HERDR_AGENT_NOT_READY", "No Agent is detected in this pane.");
          await requireDestructiveConfirmation(
            ctx,
            "Close Herdr Agent pane",
            `Close the ${pane.agent.kind} Agent by closing pane ${pane.title ?? pane.id}? Herdr v0.8.2 cannot stop only the Agent; the pane and every process in it will terminate.`,
            { id: "herdr.closeAgentPane", paneId: pane.id, agentKind: pane.agent.kind },
            signal,
          );
          return text(await bridge.closeAgent(pane.id));
        });
      },
    }),
  ];
}
