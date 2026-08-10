import type { ModelInfo } from "@contract/types";

const THINKING_SUFFIXES = new Set(["off", "minimal", "low", "medium", "high", "xhigh"]);

function stripThinkingSuffix(modelRef: string): string {
  const trimmed = modelRef.trim();
  const colonIndex = trimmed.lastIndexOf(":");
  if (colonIndex === -1) return trimmed;
  const suffix = trimmed.slice(colonIndex + 1);
  return THINKING_SUFFIXES.has(suffix) ? trimmed.slice(0, colonIndex) : trimmed;
}

export function modelRef(model: Pick<ModelInfo, "provider" | "id">): string {
  return `${model.provider}/${model.id}`;
}

export function isModelEnabled(model: ModelInfo, enabledModels: string[] | null): boolean {
  if (enabledModels === null) return true;
  const refs = new Set(enabledModels.map(stripThinkingSuffix));
  return refs.has(modelRef(model)) || refs.has(model.id);
}

function updateModelSelection(
  models: ModelInfo[],
  enabledModels: string[] | null,
  update: (selected: Set<string>) => void,
): string[] | null {
  const knownRefs = new Set(models.map(modelRef));
  const knownIds = new Set(models.map((model) => model.id));
  const preservedUnknown = (enabledModels ?? [])
    .map(stripThinkingSuffix)
    .filter((ref, index, refs) => ref && refs.indexOf(ref) === index && !knownRefs.has(ref) && !knownIds.has(ref));
  const selected = new Set(models.filter((model) => isModelEnabled(model, enabledModels)).map(modelRef));

  update(selected);

  if (selected.size === knownRefs.size && preservedUnknown.length === 0) return null;
  return [...preservedUnknown, ...selected].sort((a, b) => a.localeCompare(b));
}

export function toggleModelEnabled(
  models: ModelInfo[],
  enabledModels: string[] | null,
  target: ModelInfo,
  enabled: boolean,
): string[] | null {
  return updateModelSelection(models, enabledModels, (selected) => {
    if (enabled) selected.add(modelRef(target));
    else selected.delete(modelRef(target));
  });
}

export function setProviderModelsEnabled(
  models: ModelInfo[],
  enabledModels: string[] | null,
  providerId: string,
  enabled: boolean,
): string[] | null {
  return updateModelSelection(models, enabledModels, (selected) => {
    for (const model of models) {
      if (model.provider !== providerId) continue;
      if (enabled) selected.add(modelRef(model));
      else selected.delete(modelRef(model));
    }
  });
}
