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
  // Optional display name; when absent the provider key (the identifier) is shown.
  name?: string;
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
