import type { ModelInfo, SessionDetail } from "../contract/types";
import type { ContextUsage, SessionStatsInfo } from "./pi-types";

type Selection = { provider: string; modelId: string };

export function sessionModelForDisplay(
  override: Selection | null,
  data: SessionDetail | null | undefined,
  catalog: ModelInfo[],
  pending: Selection | null,
): Selection | null {
  if (override) return override;
  const live = data?.agentState?.state?.model;
  if (live) return { provider: live.provider, modelId: live.id };
  const selected = data?.context.selectedModel;
  if (
    selected &&
    catalog.some((model) => model.virtual && model.provider === selected.provider && model.id === selected.modelId)
  )
    return selected;
  return data?.context.model ?? pending;
}

export function sessionStatsForDisplay(
  override: SessionStatsInfo | null,
  data: SessionDetail | null | undefined,
  sessionName: string | undefined,
  contextUsage: ContextUsage | null,
): SessionStatsInfo | null {
  const stats = override ?? data?.stats;
  return stats
    ? {
        ...stats,
        sessionName: data?.info ? data.info.name : (stats.sessionName ?? sessionName),
        ...(contextUsage ? { contextUsage } : {}),
      }
    : null;
}
