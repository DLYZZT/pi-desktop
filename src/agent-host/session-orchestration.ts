import {
  createCodemodeExtension,
  createToolSearchExtension,
  type InlineExtension,
} from "@earendil-works/pi-coding-agent";
import { isOrchestrationTool } from "../shared/orchestration-tools";
import type { AgentSessionLike } from "../shared/pi-types";
import { getDefaultStore } from "./session-tool-store";

export function withSessionOrchestration(
  session: Pick<AgentSessionLike, "getAllTools">,
  active: string[],
  selection: string[] | undefined,
): string[] {
  if (selection === undefined) return active;
  const available = new Set(
    session
      .getAllTools()
      .filter((tool) => tool.exposure !== "hidden")
      .map((tool) => tool.name),
  );
  return [...active.filter((name) => !isOrchestrationTool(name)), ...selection.filter((name) => available.has(name))];
}

export function sessionOrchestrationExtensions(
  selection = (id: string) => getDefaultStore().getOrchestration(id),
): InlineExtension[] {
  return [
    { name: "codemode", builtin: true, replaceable: true, factory: createCodemodeExtension({ models: false }) },
    { name: "tool-search", builtin: true, replaceable: true, factory: createToolSearchExtension() },
    {
      name: "pi-desktop-session-orchestration",
      hidden: true,
      factory: (pi) => {
        const apply = (id: string) =>
          pi.setActiveTools(
            withSessionOrchestration({ getAllTools: () => pi.getAllTools() }, pi.getActiveTools(), selection(id)),
          );
        pi.on("session_start", (_event, ctx) => apply(ctx.sessionManager.getSessionId()));
        pi.on("before_agent_start", (_event, ctx) => apply(ctx.sessionManager.getSessionId()));
      },
    },
  ];
}
