import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import type { ModelRuntime, ResolveModelScopeResult, ScopedModel } from "@earendil-works/pi-coding-agent";
import type { AssistantMessage, SessionEntry } from "../shared/types";

// These helpers are shipped with the pinned SDK but are not root exports. Resolve from the
// actual SDK entry so development, nested packages and the packaged ASAR use the same code.
const requirePi = createRequire(import.meta.url);
function sdkCore(name: string) {
  return requirePi(fileURLToPath(new URL(`./core/${name}.js`, import.meta.resolve("@earendil-works/pi-coding-agent"))));
}

type ChatModel = NonNullable<ReturnType<ModelRuntime["getModel"]>>;
export const { findInitialModel, resolveModelScopeFromModels } = sdkCore("model-resolver") as {
  findInitialModel(options: {
    scopedModels: ScopedModel[];
    isContinuing: boolean;
    modelRuntime: ModelRuntime;
  }): Promise<{ model?: ChatModel }>;
  resolveModelScopeFromModels(patterns: string[], models: readonly ChatModel[]): ResolveModelScopeResult;
};

type CachePrices = { getModel(provider: string, id: string): { cost: { cacheRead: number } } | undefined };
export const { collectCacheMisses, detectCacheMiss } = sdkCore("cache-stats") as {
  collectCacheMisses(
    entries: SessionEntry[],
    prices: CachePrices,
  ): Map<AssistantMessage, { missedTokens: number; missedCost: number }>;
  /** `entries` must not contain `message`: Pi emits message_end before persisting it. */
  detectCacheMiss(
    entries: SessionEntry[],
    message: AssistantMessage,
    prices: CachePrices,
  ): { missedTokens: number; missedCost: number } | undefined;
};

/** The Desktop owns locking and atomic writes. Use Pi's credential value syntax and command cache. */
export const { resolveConfigValue, clearConfigValueCacheEntry } = sdkCore("resolve-config-value") as {
  resolveConfigValue(config: string, env?: Record<string, string>): string | undefined;
  clearConfigValueCacheEntry(config: string): void;
};
