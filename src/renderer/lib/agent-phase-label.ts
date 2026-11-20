import type { AgentPhase } from "./session-turn-state";
import { toolActionTitle } from "./tool-action-title.ts";

export function phaseLabel(phase: AgentPhase, t: (key: string, fallback: string) => string): string {
  if (phase?.kind === "running_tools") {
    if (phase.tools.length === 0) return t("runningTool", "Running tool…");
    if (phase.tools.length === 1) {
      const tool = phase.tools[0];
      return toolActionTitle(tool.name, tool.input, t);
    }
    return t("toolActionParallel", "Running {count} operations…").replace("{count}", String(phase.tools.length));
  }
  if (phase?.kind === "waiting_model") return t("waitingForModel", "Waiting for model…");
  if (phase?.kind === "running_command") return t("runningCommand", "Running command…");
  return t("thinking", "Thinking…");
}
