import type { AgentSessionLike } from "../shared/pi-types";
import { isOrchestrationTool } from "../shared/orchestration-tools";
import { isMcpManagedTool } from "../shared/mcp-tool-policy";
import { filterDesktopToolNames, validateDesktopToolNames } from "../shared/pi-tool-policy";
import { RpcError } from "../contract/types";
import type { SessionToolPolicy } from "./session-tool-policy";
import { getDefaultStore, type DesktopSessionToolStore } from "./session-tool-store";

export function applySessionToolCommand(
  context: {
    sessionId: string;
    session: AgentSessionLike;
    policy?: SessionToolPolicy;
    requested?: string[];
    apply(names: string[]): void;
    persist?(id: string, names: string[]): void;
    preferences?: DesktopSessionToolStore;
  },
  command: { type?: unknown; toolNames?: unknown },
) {
  validateDesktopToolNames(command.toolNames);
  const names = filterDesktopToolNames(command.toolNames);
  const store = context.preferences ?? getDefaultStore();
  const persist = context.persist ?? ((id: string, names: string[]) => store.set(id, names));
  if (command.type === "set_tools") {
    persist(context.sessionId, names);
    store.authorizeMcpSelection(context.sessionId, names);
    context.apply(names);
    return null;
  }
  if (!context.policy) throw new Error("Session execution policy is unavailable");
  if (command.type === "set_orchestration_tools") {
    const available = new Set(
      context.session
        .getAllTools()
        .filter((tool) => tool.exposure !== "hidden")
        .map((tool) => tool.name),
    );
    if (names.some((name) => !isOrchestrationTool(name) || !available.has(name)))
      throw new RpcError({ code: "BAD_REQUEST", message: "Invalid orchestration tool selection" });
    const current =
      context.requested ??
      store.get(context.sessionId) ??
      context.session.getActiveToolNames().filter((name) => !isMcpManagedTool(name));
    if (!current.length)
      throw new RpcError({ code: "BAD_REQUEST", message: "Enable a tool preset before orchestration tools" });
    if (store.get(context.sessionId) === undefined) persist(context.sessionId, current);
    store.setOrchestration(context.sessionId, names);
    context.apply(store.get(context.sessionId)!);
  } else {
    if (store.get(context.sessionId) === undefined)
      persist(context.sessionId, context.requested ?? context.session.getActiveToolNames());
    store.setExecution(context.sessionId, names);
    context.policy.setExecution(names);
  }
  return context.policy.describe();
}
