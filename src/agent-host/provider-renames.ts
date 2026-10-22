import { readFileSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";
import path from "node:path";
import { getAgentDir, type SessionEntry } from "@earendil-works/pi-coding-agent";
import { RpcError } from "../contract/types";
import type { JsonRecord } from "../shared/node/locked-json-file";
import { parseModelsConfig } from "./models-config-validation";
import { migrateSettingsFile } from "./provider-rename-migration";

const HISTORY = "_desktopProviderRenames";
export type ProviderRename = { at: number; names: Record<string, string> };
const record = (value: unknown): value is JsonRecord =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

function historyFrom(config: JsonRecord): ProviderRename[] {
  const value = config[HISTORY];
  if (!Array.isArray(value)) return [];
  return value.filter(
    (entry): entry is ProviderRename =>
      record(entry) &&
      typeof entry.at === "number" &&
      Number.isFinite(entry.at) &&
      record(entry.names) &&
      Object.values(entry.names).every((name) => typeof name === "string"),
  );
}

export function readProviderRenames(agentDir = getAgentDir()): ProviderRename[] {
  try {
    return historyFrom(parseModelsConfig(readFileSync(path.join(agentDir, "models.json"), "utf8")));
  } catch {
    // The normal SDK/config guard owns invalid-file diagnostics. Never infer a rename from broken JSON.
    return [];
  }
}

/** Keep the rename journal in the same atomic write as the provider definitions. */
export function withProviderRenames(previous: JsonRecord, next: JsonRecord, requested?: unknown): JsonRecord {
  const history = historyFrom(previous);
  if (requested !== undefined && !record(requested))
    throw new RpcError({ code: "BAD_REQUEST", message: "providerRenames must be an object" });
  const entries = Object.entries(requested ?? {});
  const sources = new Set(entries.map(([from]) => from));
  const targets = new Set<string>();
  const names: Record<string, string> = Object.create(null);
  for (const [from, to] of entries) {
    if (
      typeof to !== "string" ||
      !to.trim() ||
      to !== to.trim() ||
      from === to ||
      !record(previous.providers) ||
      !Object.hasOwn(previous.providers, from) ||
      !record(next.providers) ||
      !Object.hasOwn(next.providers, to) ||
      (Object.hasOwn(previous.providers, to) && !sources.has(to)) ||
      targets.has(to)
    )
      throw new RpcError({ code: "BAD_REQUEST", message: "Invalid provider rename" });
    targets.add(to);
    names[from] = to;
  }
  if (
    record(next.providers) &&
    entries.some(([from]) => Object.hasOwn(next.providers as JsonRecord, from) && !targets.has(from))
  )
    throw new RpcError({ code: "BAD_REQUEST", message: "A renamed provider cannot also retain its old key" });
  if (entries.length) history.push({ at: Math.max(Date.now(), (history.at(-1)?.at ?? 0) + 1), names });
  const result = { ...next };
  delete result[HISTORY];
  if (history.length) result[HISTORY] = history;
  return result;
}

/** Follow every rename in order, so chained renames resolve to the final provider key. */
export function renameThrough(provider: string, events: readonly ProviderRename[]): string {
  for (const event of events) if (Object.hasOwn(event.names, provider)) provider = event.names[provider];
  return provider;
}

export function renamedSessionProvider(
  provider: string,
  modelId: string,
  branch: readonly SessionEntry[],
  history: readonly ProviderRename[],
): string {
  const change = branch.findLast((entry) => entry.type === "model_change");
  // A response may finish after a rename; the model selection predates that response.
  const selected =
    change?.type === "model_change" && change.provider === provider && change.modelId === modelId
      ? change
      : branch.findLast(
          (entry) =>
            entry.type === "message" &&
            entry.message.role === "assistant" &&
            entry.message.provider === provider &&
            entry.message.model === modelId,
        );
  if (!selected) return provider;
  const since = Date.parse(selected.timestamp);
  return renameThrough(
    provider,
    history.filter((event) => event.at > since),
  );
}

/** Apply exactly `events`; returns the same object when no reference changed so callers can skip writing. */
export function migrateProviderSettings(settings: JsonRecord, events: readonly ProviderRename[]): JsonRecord {
  if (!events.length) return settings;
  const result = structuredClone(settings);
  for (const event of events) {
    const ref = (value: string) => {
      // Longest prefix handles provider names and model IDs containing slashes without repeated remapping.
      const from = Object.keys(event.names)
        .sort((a, b) => b.length - a.length)
        .find((name) => value.startsWith(name + "/"));
      return from === undefined ? value : event.names[from] + value.slice(from.length);
    };
    if (typeof result.defaultProvider === "string" && Object.hasOwn(event.names, result.defaultProvider))
      result.defaultProvider = event.names[result.defaultProvider];
    if (Array.isArray(result.enabledModels))
      result.enabledModels = result.enabledModels.map((value) => (typeof value === "string" ? ref(value) : value));
    const keys = (value: unknown) =>
      record(value) ? Object.fromEntries(Object.entries(value).map(([key, item]) => [ref(key), item])) : value;
    if (result.modelThinkingLevels) result.modelThinkingLevels = keys(result.modelThinkingLevels);
    if (record(result.compaction) && result.compaction.modelOverrides)
      result.compaction.modelOverrides = keys(result.compaction.modelOverrides);
  }
  return isDeepStrictEqual(result, settings) ? settings : result;
}

/** Auto routing stores raw provider keys for fast/strong/classifier. */
export function migrateRoutingSettings<T extends object>(config: T, events: readonly ProviderRename[]): T {
  let result = config as JsonRecord;
  for (const key of ["fast", "strong", "classifier"]) {
    const ref = result[key];
    if (!record(ref) || typeof ref.provider !== "string") continue;
    const provider = renameThrough(ref.provider, events);
    if (provider !== ref.provider) result = { ...result, [key]: { ...ref, provider } };
  }
  return result as T;
}

/**
 * Apply each rename once to global settings, Auto routing and trusted project settings. This is best-effort:
 * an unreadable or locked file is reported and skipped so it can never block session creation.
 */
export async function ensureProviderRenameSettings(agentDir = getAgentDir(), cwd?: string, projectTrusted = true) {
  const history = readProviderRenames(agentDir);
  if (!history.length) return false;
  const project = cwd && path.join(cwd, ".pi", "settings.json");
  type Migrate = (settings: JsonRecord, events: readonly ProviderRename[]) => JsonRecord;
  const targets: (readonly [string, Migrate])[] = [
    [path.join(agentDir, "settings.json"), migrateProviderSettings],
    [path.join(agentDir, "desktop-routing.json"), migrateRoutingSettings],
    ...(project && projectTrusted ? [[project, migrateProviderSettings] as const] : []),
  ];
  let changed = false;
  for (const [filename, migrate] of targets) {
    try {
      if (await migrateSettingsFile(agentDir, filename, history, migrate)) changed = true;
    } catch (error) {
      console.warn(`[pi-desktop] provider rename migration skipped for ${filename}: ${(error as Error).message}`);
    }
  }
  return changed;
}
