import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { AdvancedModelSettings, AutoRoutingConfig, ModelSettingsSnapshot } from "../contract/model-settings";
import { RpcError } from "../contract/types";
import { THINKING_LEVELS } from "../shared/thinking-levels";
import { withLockedJsonFile } from "../shared/node/locked-json-file";

const ADVANCED_KEYS = ["compaction", "retry", "transport"] as const;

export const DEFAULT_ROUTING: AutoRoutingConfig = {
  enabled: false,
  strategy: "thinking",
  fastThinking: "low",
  strongThinking: "high",
  retryFallback: false,
};

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
function invalid(message: string): never {
  throw new RpcError({ code: "BAD_REQUEST", message });
}

export function validateRouting(value: unknown): asserts value is AutoRoutingConfig {
  if (
    !record(value) ||
    typeof value.enabled !== "boolean" ||
    !["thinking", "classifier"].includes(String(value.strategy)) ||
    typeof value.retryFallback !== "boolean"
  )
    invalid("Invalid routing configuration");
  for (const key of ["fastThinking", "strongThinking"])
    if (!THINKING_LEVELS.includes(value[key] as never)) invalid(`Invalid ${key}`);
  for (const key of ["fast", "strong", "classifier"]) {
    const ref = value[key];
    if (
      ref !== undefined &&
      (!record(ref) ||
        typeof ref.provider !== "string" ||
        !ref.provider.trim() ||
        ref.provider.length > 256 ||
        typeof ref.modelId !== "string" ||
        !ref.modelId.trim() ||
        ref.modelId.length > 512)
    )
      invalid(`Invalid ${key} model`);
  }
  if (value.enabled && (!value.fast || !value.strong || (value.strategy === "classifier" && !value.classifier)))
    invalid("Select the routing models before enabling Auto");
}

export function validateAdvanced(value: unknown): asserts value is AdvancedModelSettings {
  if (!record(value)) invalid("Invalid advanced settings");
  for (const key of Object.keys(value))
    if (!(ADVANCED_KEYS as readonly string[]).includes(key)) invalid(`Unknown setting: ${key}`);
  if (
    value.transport !== undefined &&
    !["auto", "sse", "websocket", "websocket-cached"].includes(String(value.transport))
  )
    invalid("Invalid transport");
  function fields(input: unknown, numbers: string[], extra: string[] = []) {
    if (!record(input)) invalid("Expected a settings object");
    for (const [key, entry] of Object.entries(input)) {
      if (entry === undefined) continue;
      if (numbers.includes(key)) {
        if (!Number.isSafeInteger(entry) || (entry as number) < 0)
          invalid(`${key} must be a non-negative safe integer`);
      } else if (key === "enabled") {
        if (typeof entry !== "boolean") invalid("enabled must be a boolean");
      } else if (!extra.includes(key)) invalid(`Unknown setting: ${key}`);
    }
    return input;
  }
  if (value.compaction !== undefined) {
    const compaction = fields(value.compaction, ["reserveTokens", "keepRecentTokens"], ["modelOverrides"]);
    if (compaction.modelOverrides !== undefined) {
      if (!record(compaction.modelOverrides)) invalid("Invalid model compaction overrides");
      for (const [key, override] of Object.entries(compaction.modelOverrides)) {
        if (!key.includes("/") || key.length > 768) invalid("Use provider/modelId for compaction overrides");
        fields(override, ["reserveTokens", "keepRecentTokens"]);
      }
    }
  }
  if (value.retry !== undefined) {
    const retry = fields(value.retry, ["maxRetries", "baseDelayMs", "maxAgentDelayMs"], ["provider"]);
    if (retry.provider !== undefined) fields(retry.provider, ["timeoutMs", "maxRetries", "maxRetryDelayMs"]);
  }
}

function contentVersion(raw: string | null): string {
  return raw === null ? "missing" : createHash("sha256").update(raw).digest("hex");
}

function readRaw(file: string): string | null {
  return existsSync(file) ? readFileSync(file, "utf8") : null;
}

function read(file: string): { raw: string | null; value: Record<string, unknown>; version: string } {
  const raw = readRaw(file);
  let value: unknown;
  try {
    value = raw === null ? {} : JSON.parse(raw);
  } catch {
    throw new RpcError({ code: "PARSE_ERROR", message: `Cannot parse ${path.basename(file)}` });
  }
  if (!record(value)) throw new RpcError({ code: "PARSE_ERROR", message: `Invalid ${path.basename(file)}` });
  return { raw, value, version: contentVersion(raw) };
}

export function readRoutingSettings(agentDir = getAgentDir()): ModelSettingsSnapshot<AutoRoutingConfig> {
  const snapshot = read(path.join(agentDir, "desktop-routing.json"));
  const config = { ...DEFAULT_ROUTING, ...snapshot.value };
  validateRouting(config);
  return { config, version: snapshot.version };
}

export function readAdvancedSettings(agentDir = getAgentDir()): ModelSettingsSnapshot<AdvancedModelSettings> {
  const { value, version } = read(path.join(agentDir, "settings.json"));
  const config = Object.fromEntries(
    ADVANCED_KEYS.flatMap((key) => (value[key] === undefined ? [] : [[key, value[key]]])),
  ) as AdvancedModelSettings;
  return { config, version };
}

async function write(
  file: string,
  expectedVersion: string,
  project: (previous: Record<string, unknown>) => Record<string, unknown>,
) {
  if (typeof expectedVersion !== "string" || !expectedVersion) invalid("expectedVersion is required");
  const assertVersion = (raw: string | null) => {
    if (contentVersion(raw) !== expectedVersion)
      throw new RpcError({ code: "CONFLICT", message: `${path.basename(file)} changed. Reload before saving.` });
  };
  await withLockedJsonFile(file, async (current, save, text) => {
    // Check and merge the same snapshot; re-check right before rename for writers outside the lock.
    assertVersion(text);
    await save(project(current), () => assertVersion(readRaw(file)));
  });
}

export async function saveRoutingSettings(config: AutoRoutingConfig, version: string, agentDir = getAgentDir()) {
  validateRouting(config);
  await write(path.join(agentDir, "desktop-routing.json"), version, () => ({ ...config }));
  return readRoutingSettings(agentDir);
}

export async function saveAdvancedSettings(config: AdvancedModelSettings, version: string, agentDir = getAgentDir()) {
  validateAdvanced(config);
  await write(path.join(agentDir, "settings.json"), version, (previous) => {
    const next = { ...previous };
    for (const key of ADVANCED_KEYS) {
      if (config[key] === undefined) delete next[key];
      else next[key] = config[key];
    }
    return next;
  });
  return readAdvancedSettings(agentDir);
}
