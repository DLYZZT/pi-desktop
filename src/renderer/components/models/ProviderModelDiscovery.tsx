import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { call } from "@/lib/api-client";
import { mergeDiscoveredModels, type ProviderEntry } from "@/lib/models-config-state";
import { useI18n } from "@/i18n";

function connectionKey(provider: ProviderEntry): string {
  return JSON.stringify([provider.baseUrl, provider.api, provider.apiKey, provider.headers]);
}

type DiscoveryState =
  | { phase: "idle" }
  | { phase: "loading"; source: string }
  | { phase: "error"; source: string; message: string }
  | { phase: "success"; source: string; found: number; added: number };

export function ProviderModelDiscovery({
  provider,
  onChange,
}: {
  provider: ProviderEntry;
  onChange: (provider: ProviderEntry) => void;
}) {
  const { t } = useI18n();
  const [state, setState] = useState<DiscoveryState>({ phase: "idle" });
  const latest = useRef({ provider, onChange });
  const generation = useRef(0);
  useLayoutEffect(() => {
    latest.current = { provider, onChange };
  });
  useEffect(
    () => () => {
      generation.current++;
    },
    [],
  );
  const source = connectionKey(provider);
  const current = state.phase !== "idle" && state.source === source ? state : { phase: "idle" as const };
  const supported = !provider.api || ["openai-completions", "openai-responses"].includes(provider.api);
  const busy = current.phase === "loading";

  const discover = async () => {
    if (busy || !supported || !provider.baseUrl?.trim()) return;
    const request = ++generation.current;
    setState({ phase: "loading", source });
    const isCurrent = () => request === generation.current && connectionKey(latest.current.provider) === source;
    try {
      const result = await call("modelsConfig.discover", { provider });
      if (!isCurrent()) return;
      if (!result.ok) {
        setState({ phase: "error", source, message: result.error });
        return;
      }
      const merged = mergeDiscoveredModels(latest.current.provider, result.models, result.baseUrl);
      latest.current.onChange(merged.provider);
      setState({
        phase: "success",
        source: connectionKey(merged.provider),
        found: result.models.length,
        added: merged.added,
      });
    } catch (error) {
      if (isCurrent())
        setState({ phase: "error", source, message: error instanceof Error ? error.message : String(error) });
    }
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <button
        type="button"
        onClick={() => void discover()}
        disabled={busy || !supported || !provider.baseUrl?.trim()}
        style={{
          alignSelf: "flex-start",
          minHeight: 32,
          padding: "0 12px",
          background: "var(--bg-panel)",
          color: busy || !supported || !provider.baseUrl?.trim() ? "var(--text-dim)" : "var(--text)",
          border: "1px solid var(--border)",
          borderRadius: 4,
          cursor: busy || !supported || !provider.baseUrl?.trim() ? "not-allowed" : "pointer",
          fontSize: 12,
        }}
      >
        {busy ? t("modelDiscovering", "Fetching models…") : t("modelDiscover", "Fetch model list")}
      </button>
      <span style={{ fontSize: 11, color: "var(--text-dim)", lineHeight: 1.6 }}>
        {t(
          "modelDiscoverHint",
          "Fetch models from an OpenAI-compatible /models endpoint using this URL and API key. New IDs are added without replacing existing settings. Save below to apply.",
        )}
      </span>
      <div role={current.phase === "error" ? "alert" : "status"} aria-live="polite" style={{ fontSize: 12 }}>
        {current.phase === "error" && <span style={{ color: "var(--danger)" }}>{current.message}</span>}
        {current.phase === "success" &&
          (current.found === 0
            ? t("modelDiscoverEmpty", "The endpoint returned no models.")
            : t("modelDiscoverSuccess", "Found {found} models; added {added}. Review their capabilities before saving.")
                .replace("{found}", String(current.found))
                .replace("{added}", String(current.added)))}
      </div>
    </div>
  );
}
