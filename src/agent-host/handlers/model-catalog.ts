import { statSync } from "node:fs";
import { getAgentDir, type ModelRuntime, type SettingsManager } from "@earendil-works/pi-coding-agent";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import type { ApiHandler } from "../../contract/rpc";
import {
  RpcError,
  type ModelInfo,
  type ModelCatalogStatus,
  type ModelCatalogWarning,
  type ModelPreferencesResult,
  type ModelsListResult,
} from "../../contract/types";
import { modelCatalogRefreshCoordinator } from "../model-runtime";
import { createDesktopAgentSessionServices as createAgentSessionServices } from "../desktop-session-services";
import { stripThinkingSuffix } from "../../shared/thinking-levels";

function filterByExactEnabledModels<T extends { id: string; provider: string }>(
  available: T[],
  enabledModels: string[] | undefined,
): T[] {
  if (!enabledModels || enabledModels.length === 0) return available;
  const refs = new Set(enabledModels.map(stripThinkingSuffix).filter(Boolean));
  const visible = available.filter((m) => refs.has(`${m.provider}/${m.id}`) || refs.has(m.id));
  return visible.length > 0 ? visible : available;
}

function projectModelPreferences<T extends { id: string; name: string; provider: string }>(
  available: readonly T[],
  enabledModels: string[] | undefined,
): ModelPreferencesResult {
  const models: ModelInfo[] = available
    .map((model) => ({ id: model.id, name: model.name, provider: model.provider }))
    .sort((a, b) => a.name.localeCompare(b.name) || a.provider.localeCompare(b.provider) || a.id.localeCompare(b.id));
  const normalized = [...new Set((enabledModels ?? []).map(stripThinkingSuffix).filter(Boolean))];
  return { models, enabledModels: normalized.length > 0 ? normalized : null };
}

function normalizeEnabledModelsInput(value: unknown): string[] | undefined {
  if (value === null) return undefined;
  if (!Array.isArray(value) || value.length === 0 || value.length > 2000) {
    throw new RpcError({
      code: "BAD_REQUEST",
      message: "enabledModels must be null or a non-empty array with at most 2000 entries",
    });
  }

  const normalized: string[] = [];
  const seen = new Set<string>();
  for (const valueEntry of value) {
    if (typeof valueEntry !== "string") {
      throw new RpcError({ code: "BAD_REQUEST", message: "Every enabled model reference must be a string" });
    }
    const modelReference = stripThinkingSuffix(valueEntry);
    if (!modelReference || modelReference.length > 512) {
      throw new RpcError({ code: "BAD_REQUEST", message: "Invalid enabled model reference" });
    }
    if (!seen.has(modelReference)) {
      seen.add(modelReference);
      normalized.push(modelReference);
    }
  }
  return normalized;
}

function hasMatchingEnabledModel<T extends { id: string; provider: string }>(
  available: readonly T[],
  enabledModels: string[],
): boolean {
  const refs = new Set(enabledModels);
  return available.some((model) => refs.has(`${model.provider}/${model.id}`) || refs.has(model.id));
}

function resolveModelsCwd(params: { cwd?: string } | void): string {
  const cwd = params?.cwd || process.cwd();
  try {
    const st = statSync(cwd);
    if (!st.isDirectory()) throw new Error("not-directory");
  } catch {
    throw new RpcError({ code: "BAD_REQUEST", message: `Directory does not exist: ${cwd}` });
  }
  return cwd;
}

export type AvailableModel = Awaited<ReturnType<ModelRuntime["getAvailable"]>>[number];

async function resolveAvailableModels(
  modelRuntime: ModelRuntime,
  signal?: AbortSignal,
): Promise<{ models: AvailableModel[]; warnings: ModelCatalogWarning[] }> {
  const snapshot = [...modelRuntime.getAvailableSnapshot()];
  const snapshotByProvider = new Map<string, AvailableModel[]>();
  for (const model of snapshot) {
    const models = snapshotByProvider.get(model.provider) ?? [];
    models.push(model);
    snapshotByProvider.set(model.provider, models);
  }

  const results = await Promise.all(
    [...modelRuntime.getProviders()]
      .sort((a, b) => a.id.localeCompare(b.id))
      .map(async (provider) => {
        try {
          const models = [...(await modelRuntime.getAvailable(provider.id, { signal }))];
          return { models, warning: undefined };
        } catch (error) {
          if (signal?.aborted) throw signal.reason ?? error;
          return {
            models: snapshotByProvider.get(provider.id) ?? [],
            warning: {
              provider: provider.id,
              code: "PROVIDER_AVAILABILITY_FAILED" as const,
              message: `Unable to check ${provider.id} model availability; the last known state remains available.`,
            },
          };
        }
      }),
  );
  signal?.throwIfAborted();
  return {
    models: results.flatMap((result) => result.models),
    warnings: results.flatMap((result) => (result.warning ? [result.warning] : [])),
  };
}

export async function projectModelsList(
  modelRuntime: ModelRuntime,
  settings: SettingsManager,
  catalog: ModelCatalogStatus,
  options: { signal?: AbortSignal; cachedOnly?: boolean } = {},
): Promise<ModelsListResult> {
  const availability = options.cachedOnly
    ? { models: [...modelRuntime.getAvailableSnapshot()], warnings: [] }
    : await resolveAvailableModels(modelRuntime, options.signal);
  const available = availability.models;
  const enabledModels = settings.getEnabledModels();
  const visible = filterByExactEnabledModels(available, enabledModels);
  const models = visible
    .map((model) => ({ id: model.id, name: model.name, provider: model.provider }))
    .sort((a, b) => a.name.localeCompare(b.name) || a.provider.localeCompare(b.provider));

  const nameMap: Record<string, string> = {};
  const thinkingLevels: Record<string, string[]> = {};
  const thinkingLevelMaps: Record<string, Record<string, string | null>> = {};
  for (const model of visible) {
    const key = `${model.provider}:${model.id}`;
    nameMap[key] = model.name;
    thinkingLevels[key] = getSupportedThinkingLevels(model);
    if (model.thinkingLevelMap) thinkingLevelMaps[key] = model.thinkingLevelMap;
  }

  let defaultModel: { provider: string; modelId: string } | null = null;
  const provider = settings.getDefaultProvider();
  const modelId = settings.getDefaultModel();
  if (provider) {
    defaultModel = { provider, modelId: modelId ?? "" };
  }

  return {
    models,
    defaultModel,
    thinkingLevels,
    thinkingLevelMaps,
    nameMap,
    catalog: availability.warnings.length
      ? { ...catalog, warnings: [...catalog.warnings, ...availability.warnings] }
      : catalog,
  };
}

type ModelCatalogHandlers = {
  list: NonNullable<ApiHandler["models.list"]>;
  refresh: NonNullable<ApiHandler["models.refresh"]>;
  cancelRefresh: NonNullable<ApiHandler["models.refreshCancel"]>;
  getPreferences: NonNullable<ApiHandler["models.preferences.get"]>;
  setPreferences: NonNullable<ApiHandler["models.preferences.set"]>;
};

export const modelCatalogHandlers = {
  list: async (params) => {
    const cwd = resolveModelsCwd(params as { cwd?: string } | void);
    const agentDir = getAgentDir();
    const services = await createAgentSessionServices({ cwd, agentDir });
    return projectModelsList(services.modelRuntime, services.settingsManager, {
      source: process.env.PI_OFFLINE === undefined ? "cache" : "offline",
      refreshed: false,
      aborted: false,
      warnings: [],
    });
  },

  refresh: async (params) => {
    const { requestId } = params as { cwd?: string; requestId: string };
    if (!/^[A-Za-z0-9_-]{1,100}$/.test(requestId)) {
      throw new RpcError({ code: "BAD_REQUEST", message: "Invalid model refresh request id" });
    }
    const cwd = resolveModelsCwd(params);
    const agentDir = getAgentDir();
    return modelCatalogRefreshCoordinator.refresh(
      cwd,
      requestId,
      (signal) => createAgentSessionServices({ cwd, agentDir, modelRuntimeSignal: signal }),
      ({ services, catalog }, signal) =>
        projectModelsList(services.modelRuntime, services.settingsManager, catalog, {
          signal,
          cachedOnly: catalog.aborted,
        }),
    );
  },

  cancelRefresh: (params) => {
    const { requestId } = params as { requestId: string };
    return { ok: true as const, cancelled: modelCatalogRefreshCoordinator.cancel(requestId) };
  },

  getPreferences: async (params) => {
    const cwd = resolveModelsCwd(params as { cwd?: string } | void);
    const services = await createAgentSessionServices({ cwd, agentDir: getAgentDir() });
    const { models: available } = await resolveAvailableModels(services.modelRuntime);
    return projectModelPreferences(available, services.settingsManager.getEnabledModels());
  },

  setPreferences: async (params) => {
    const body = params as { cwd?: string; enabledModels?: unknown };
    const cwd = resolveModelsCwd(body);
    const enabledModels = normalizeEnabledModelsInput(body.enabledModels);
    const services = await createAgentSessionServices({ cwd, agentDir: getAgentDir() });
    const { models: available } = await resolveAvailableModels(services.modelRuntime);
    if (enabledModels && !hasMatchingEnabledModel(available, enabledModels)) {
      throw new RpcError({ code: "BAD_REQUEST", message: "At least one available model must remain enabled" });
    }
    services.settingsManager.setEnabledModels(enabledModels);
    return projectModelPreferences(available, enabledModels);
  },
} satisfies ModelCatalogHandlers;
