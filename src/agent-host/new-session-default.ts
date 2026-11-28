import type { ModelRuntime, SettingsManager } from "@earendil-works/pi-coding-agent";
import { findInitialModel, resolveModelScopeFromModels } from "./pi-sdk-core";

/** Use the same offline model resolver as Pi startup. Explicit saved selections go through the restore guard. */
export async function implicitSessionModel(runtime: ModelRuntime, settings: SettingsManager) {
  const patterns = settings.getEnabledModels?.();
  const scopedModels = patterns?.length
    ? resolveModelScopeFromModels(patterns, runtime.getAvailableSnapshot()).scopedModels
    : [];
  return (await findInitialModel({ modelRuntime: runtime, isContinuing: false, scopedModels })).model;
}
