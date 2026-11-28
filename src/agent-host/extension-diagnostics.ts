import type { ExtensionUiRequest } from "../shared/types";
import { createHash, randomUUID } from "node:crypto";
import type {
  AgentSessionRuntimeDiagnostic,
  ModelRuntime,
  DefaultResourceLoader,
} from "@earendil-works/pi-coding-agent";
import type { AgentSessionLike } from "../shared/pi-types";
import { resolveModelScopeFromModels } from "./pi-sdk-core";

type Loaded = ReturnType<DefaultResourceLoader["getExtensions"]>;
export type ExtensionDiagnosticStatus = { key: string; text: string };

function safeDiagnosticMessage(message: string): string {
  return message
    .replace(/\b(sk-[A-Za-z0-9_-]{8,}|gh[pousr]_[A-Za-z0-9_]{8,})\b/g, "[redacted]")
    .replace(/\b(api[_ -]?key|token|authorization)(\s*[:=]\s*)[^\s,;]+/gi, "$1$2[redacted]")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 240);
}

export function projectExtensionDiagnostics(
  diagnostics: readonly AgentSessionRuntimeDiagnostic[],
): ExtensionDiagnosticStatus[] {
  const byKey = new Map<string, string>();
  for (const { type, message } of diagnostics) {
    const key = `pi-runtime-${type}-${createHash("sha256").update(message).digest("hex").slice(0, 24)}`;
    byKey.set(key, safeDiagnosticMessage(message) || `Pi runtime ${type}`);
  }
  return Array.from(byKey, ([key, text]) => ({ key, text }));
}

function sessionDiagnostics(inner: AgentSessionLike, initial: readonly AgentSessionRuntimeDiagnostic[]) {
  const diagnostics = [...initial];
  const loaded = inner.resourceLoader?.getExtensions?.();
  for (const item of loaded?.errors ?? [])
    diagnostics.push({ type: "error", message: `Extension "${item.path}" error: ${item.error}` });
  for (const item of loaded?.warnings ?? [])
    diagnostics.push({ type: "warning", message: `Extension "${item.path}" warning: ${item.warning}` });
  const patterns = inner.settingsManager?.getEnabledModels?.();
  if (patterns?.length && inner.modelRuntime.getAvailableSnapshot) {
    const scope = resolveModelScopeFromModels(patterns, inner.modelRuntime.getAvailableSnapshot());
    // Picker preferences are shared across sessions and can outlive a provider's available catalog.
    for (const diagnostic of scope.diagnostics) {
      if (diagnostic.code !== "no-match") diagnostics.push(diagnostic);
    }
  }
  return projectExtensionDiagnostics(diagnostics);
}

/** On reload Pi registers providers before binding the new runner's error listener. Keep
 * registration failures on that resource generation, including when the same file is later fixed. */
export function observeProviderRegistrations(runtime: ModelRuntime) {
  let owners = new WeakMap<object, { loaded: Loaded; path: string }>();
  function invoke<T>(definition: object, register: () => T) {
    try {
      return register();
    } catch (error) {
      const owner = owners.get(definition);
      if (owner)
        owner.loaded.errors.push({ path: owner.path, error: error instanceof Error ? error.message : String(error) });
      throw error;
    }
  }
  const registrations: Pick<ModelRuntime, "registerProvider" | "registerNativeProvider" | "registerVirtualModel"> = {
    registerProvider: (name, config) => invoke(config, () => runtime.registerProvider(name, config)),
    registerNativeProvider: (provider) => invoke(provider, () => runtime.registerNativeProvider(provider)),
    registerVirtualModel: (definition) => invoke(definition, () => runtime.registerVirtualModel(definition)),
  };
  return {
    runtime: new Proxy(runtime, {
      get(target, key) {
        if (Object.hasOwn(registrations, key)) return registrations[key as keyof typeof registrations];
        const value = Reflect.get(target, key, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }),
    observe(loaded: Loaded) {
      owners = new WeakMap();
      for (const { extensionPath: path, config } of loaded.runtime.pendingProviderRegistrations)
        owners.set(config, { loaded, path });
      for (const { extensionPath: path, provider } of loaded.runtime.pendingNativeProviderRegistrations)
        owners.set(provider, { loaded, path });
      for (const { extensionPath: path, definition } of loaded.runtime.pendingVirtualModelRegistrations)
        owners.set(definition, { loaded, path });
      return loaded;
    },
  };
}

export function reconcileDiagnosticStatuses(
  inner: AgentSessionLike,
  diagnostics: readonly AgentSessionRuntimeDiagnostic[],
  previous: Map<string, string>,
  publish: (event: Extract<ExtensionUiRequest, { method: "setStatus" }>) => void,
) {
  const next = new Map(sessionDiagnostics(inner, diagnostics).map(({ key, text }) => [key, text]));
  for (const key of new Set([...previous.keys(), ...next.keys()])) {
    if (next.get(key) !== previous.get(key))
      publish({
        type: "extension_ui_request",
        id: randomUUID(),
        method: "setStatus",
        statusKey: key,
        statusText: next.get(key),
      });
  }
  return next;
}
