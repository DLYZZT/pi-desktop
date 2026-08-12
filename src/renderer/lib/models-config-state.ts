export interface ModelEntry {
  id: string;
  name?: string;
  api?: string;
  reasoning?: boolean;
  thinkingLevelMap?: Record<string, string | null>;
  input?: string[];
  contextWindow?: number;
  maxTokens?: number;
  cost?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number };
  compat?: Record<string, unknown>;
  samplingParams?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface ProviderEntry {
  baseUrl?: string;
  api?: string;
  apiKey?: string;
  headers?: Record<string, string | null>;
  compat?: Record<string, unknown>;
  models?: ModelEntry[];
  modelOverrides?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface ModelsJson {
  providers?: Record<string, ProviderEntry>;
  [key: string]: unknown;
}

export type ModelsConfigSelection =
  | { type: "provider"; name: string }
  | { type: "model"; providerName: string; index: number }
  | { type: "oauth"; providerId: string }
  | { type: "apikey"; providerId: string };

const RESERVED_PROVIDER_NAMES = new Set(["__proto__", "prototype", "constructor"]);

export type RenameProviderResult =
  { ok: true; config: ModelsJson; name: string } | { ok: false; config: ModelsJson; error: string };

export function renameProviderEntry(config: ModelsJson, oldName: string, requestedName: string): RenameProviderResult {
  const name = requestedName.trim();
  if (!name) return { ok: false, config, error: "Provider name cannot be empty." };
  if (RESERVED_PROVIDER_NAMES.has(name)) {
    return { ok: false, config, error: `Provider name “${name}” is reserved.` };
  }

  const providers = config.providers ?? {};
  if (!Object.prototype.hasOwnProperty.call(providers, oldName)) {
    return { ok: false, config, error: `Provider “${oldName}” no longer exists.` };
  }
  if (name !== oldName && Object.prototype.hasOwnProperty.call(providers, name)) {
    return { ok: false, config, error: `Provider “${name}” already exists.` };
  }
  if (name === oldName) return { ok: true, config, name };

  const entries = Object.entries(providers);
  const index = entries.findIndex(([providerName]) => providerName === oldName);
  entries[index] = [name, entries[index][1]];
  return { ok: true, config: { ...config, providers: Object.fromEntries(entries) }, name };
}

export function selectionAfterProviderRename(
  selection: ModelsConfigSelection | null,
  oldName: string,
  newName: string,
): ModelsConfigSelection | null {
  if (selection?.type === "provider" && selection.name === oldName) return { type: "provider", name: newName };
  if (selection?.type === "model" && selection.providerName === oldName) {
    return { ...selection, providerName: newName };
  }
  return selection;
}

export function deleteProviderTransition(
  config: ModelsJson,
  selection: ModelsConfigSelection | null,
  providerName: string,
): { config: ModelsJson; selection: ModelsConfigSelection | null } {
  const currentProviders = config.providers ?? {};
  if (!Object.prototype.hasOwnProperty.call(currentProviders, providerName)) return { config, selection };

  const providers = { ...currentProviders };
  delete providers[providerName];
  const selectionWasDeleted =
    (selection?.type === "provider" && selection.name === providerName) ||
    (selection?.type === "model" && selection.providerName === providerName);
  const nextProviderName = Object.keys(providers)[0];
  return {
    config: { ...config, providers },
    selection: selectionWasDeleted
      ? nextProviderName
        ? { type: "provider", name: nextProviderName }
        : null
      : selection,
  };
}

export function addModelTransition(
  config: ModelsJson,
  providerName: string,
): { config: ModelsJson; selection: ModelsConfigSelection } {
  const provider = config.providers?.[providerName] ?? {};
  const models = [...(provider.models ?? []), { id: "" }];
  return {
    config: {
      ...config,
      providers: { ...(config.providers ?? {}), [providerName]: { ...provider, models } },
    },
    selection: { type: "model", providerName, index: models.length - 1 },
  };
}

export function setProviderBaseUrl(config: ModelsJson, providerName: string, baseUrl: string): ModelsJson {
  const providers = { ...(config.providers ?? {}) };
  const provider = { ...(providers[providerName] ?? {}) };
  const normalized = baseUrl.trim();

  if (normalized) {
    provider.baseUrl = normalized;
    providers[providerName] = provider;
  } else {
    delete provider.baseUrl;
    if (Object.keys(provider).length > 0) providers[providerName] = provider;
    else delete providers[providerName];
  }

  return { ...config, providers };
}

export function replaceModelEntry(
  config: ModelsJson,
  providerName: string,
  index: number,
  model: ModelEntry,
): ModelsJson {
  const provider = config.providers?.[providerName] ?? {};
  const models = [...(provider.models ?? [])];
  models[index] = model;
  return {
    ...config,
    providers: {
      ...(config.providers ?? {}),
      [providerName]: { ...provider, models },
    },
  };
}
