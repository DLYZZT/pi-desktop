import type { SessionEntry } from "@earendil-works/pi-coding-agent";

/** Matches Pi's branch-selection semantics: a registered virtual selection survives physical replies. */
export function getBranchModelSelection(
  branch: readonly SessionEntry[],
  getModel: (provider: string, id: string) => { api?: string } | undefined,
) {
  const change = branch.findLast((entry) => entry.type === "model_change");
  if (change?.type === "model_change" && getModel(change.provider, change.modelId)?.api === "pi-virtual")
    return { provider: change.provider, modelId: change.modelId };
  for (let index = branch.length - 1; index >= 0; index--) {
    const entry = branch[index];
    if (entry.type === "model_change") return { provider: entry.provider, modelId: entry.modelId };
    if (entry.type === "message" && entry.message.role === "assistant" && entry.message.api !== "pi-virtual")
      return { provider: entry.message.provider, modelId: entry.message.model };
  }
  return undefined;
}
