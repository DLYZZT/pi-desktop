import { useEffect, useId, useMemo, useState } from "react";
import { Checkbox } from "@/components/ui/Checkbox";
import { Input } from "@/components/ui/Input";
import { Select } from "@/components/ui/Select";
import { useI18n } from "@/i18n";

type Translate = ReturnType<typeof useI18n>["t"];
import { getWebSearchSettings, setWebSearchSettings, testWebSearchSettings } from "@/lib/api-client";
import type { WebSearchSnapshot } from "@shared/web-search";
import { SettingRow } from "./settings-controls";
import { Button } from "@/components/ui/Button";

const inputStyle = {
  minWidth: 220,
  minHeight: 36,
  padding: "7px 10px",
  borderRadius: 6,
  fontSize: 13,
} as const;

const hintStyle = { margin: "8px 0 0", fontSize: 12, lineHeight: 1.55, color: "var(--text-dim)" } as const;

/**
 * Per-provider hint/placeholder lookups. Every provider gets a static `t()`
 * branch so the i18n invariants (registered fallbacks, en-US parity) hold;
 * unknown providers fall back to the generic lines below.
 */
function providerHint(t: Translate, providerId: string, supportsFetch: boolean): string {
  switch (providerId) {
    case "deepseek":
      return t(
        "webSearchProviderDeepSeekHint",
        "DeepSeek provides both web_search and web_fetch; charges per 1,000 calls. Reuses the DeepSeek provider key from Settings → Models unless a dedicated key is saved below.",
      );
    case "tencent-wsa":
      return t(
        "webSearchProviderTencentWsaHint",
        "Tencent Yuanbao Search provides web_search only (no web_fetch); it bills per successful call. Configure its own service API KEY below — a DeepSeek key cannot be used here.",
      );
    default:
      return supportsFetch
        ? ""
        : t(
            "webSearchProviderTencentWsaHint",
            "Tencent Yuanbao Search provides web_search only (no web_fetch); it bills per successful call. Configure its own service API KEY below — a DeepSeek key cannot be used here.",
          );
  }
}

function keyPlaceholder(t: Translate, providerId: string): string {
  switch (providerId) {
    case "deepseek":
      return t("webSearchApiKeyOverridePlaceholderDeepSeek", "Reuse the DeepSeek provider key");
    case "tencent-wsa":
      return t("webSearchApiKeyOverridePlaceholderTencentWsa", "Tencent Yuanbao search service API KEY (sk-…)");
    default:
      return t("webSearchApiKeyOverridePlaceholderDeepSeek", "Reuse the DeepSeek provider key");
  }
}

/**
 * Web search tools panel. The feature is off by default because every
 * successful provider call is billed; the panel owns its own load/save cycle.
 * The provider choice and each provider's key draft live here; saving
 * persists only the edited provider's fields.
 */
export function WebSearchSettings() {
  const { t } = useI18n();
  const controlId = useId();
  const providerControlId = useId();
  const keyControlId = useId();
  const [snapshot, setSnapshot] = useState<WebSearchSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [error, setError] = useState<"load" | "save" | null>(null);
  const [testResult, setTestResult] = useState<{ ok: boolean; text: string } | null>(null);
  const [keyDrafts, setKeyDrafts] = useState<Record<string, string>>({});

  useEffect(() => {
    let disposed = false;
    void getWebSearchSettings()
      .then((result) => {
        if (disposed) return;
        setSnapshot(result);
        setKeyDrafts({ ...(result.settings.apiKeys ?? {}) });
        setError(result.loadFailed ? "load" : null);
      })
      .catch(() => {
        if (!disposed) setError("load");
      })
      .finally(() => {
        if (!disposed) setLoading(false);
      });
    return () => {
      disposed = true;
    };
  }, []);

  const save = async (patch: Parameters<typeof setWebSearchSettings>[0]): Promise<void> => {
    setSaving(true);
    setError(null);
    try {
      const result = await setWebSearchSettings(patch);
      setSnapshot(result);
      if (patch.apiKeys !== undefined) setKeyDrafts({ ...(result.settings.apiKeys ?? {}) });
    } catch {
      try {
        const reloaded = await getWebSearchSettings();
        setSnapshot(reloaded);
        setKeyDrafts({ ...(reloaded.settings.apiKeys ?? {}) });
      } catch {
        /* keep the last known snapshot */
      }
      setError("save");
    } finally {
      setSaving(false);
    }
  };

  const providerId = snapshot?.settings.providerId ?? "";
  // Stable identity keeps the useMemo below from recomputing on every render.
  const providers = useMemo(() => snapshot?.providers ?? [], [snapshot]);
  const activeProvider = useMemo(
    () => providers.find((provider) => provider.id === providerId),
    [providers, providerId],
  );
  // Optional chains guard against a host that predates multi-provider settings.
  const savedKey = snapshot?.settings.apiKeys?.[providerId] ?? "";
  const keyDraft = keyDrafts[providerId] ?? "";
  const keyDirty = snapshot !== null && keyDraft.trim() !== savedKey;

  const switchProvider = async (id: string): Promise<void> => {
    setTestResult(null);
    await save({ providerId: id });
  };

  const saveKey = async (): Promise<void> => {
    if (!providerId) return;
    await save({ apiKeys: { ...snapshot?.settings.apiKeys, [providerId]: keyDraft.trim() } });
  };
  const test = async (): Promise<void> => {
    if (!providerId) return;
    setTesting(true);
    setTestResult(null);
    try {
      // A dirty draft is validated as typed; otherwise the saved key is tested.
      const draft = keyDirty ? keyDraft.trim() : undefined;
      const response = await testWebSearchSettings({
        providerId,
        ...(draft === undefined ? {} : { apiKeyOverride: draft }),
      });
      setTestResult({
        ok: response.ok,
        text: response.ok
          ? `${t("webSearchTestPassed", "Test passed")} · ${response.latencyMs ?? 0} ms · ${response.responseText ?? ""}` +
            (snapshot?.settings.enabled
              ? ""
              : ` ${t("webSearchTestDisabledHint", "Enable the switch above to let the Agent use it.")}`)
          : (response.error ?? t("webSearchTestFailed", "Test failed")),
      });
    } catch (cause) {
      setTestResult({ ok: false, text: cause instanceof Error ? cause.message : String(cause) });
    } finally {
      setTesting(false);
    }
  };

  const credential = snapshot?.credential.source;
  const busy = loading || saving;

  return (
    <div style={{ width: "100%", overflowY: "auto", padding: "28px clamp(18px, 5vw, 52px)" }}>
      <section aria-labelledby={`${controlId}-heading`} style={{ maxWidth: 620 }}>
        <h2 id={`${controlId}-heading`} style={{ margin: 0, fontSize: 14, color: "var(--text)" }}>
          {t("webSearch", "Web search")}
        </h2>
        <p style={{ ...hintStyle, margin: "6px 0 16px" }}>
          {t(
            "webSearchDescription",
            "Give the Agent web_search and web_fetch tools for current information. Search is billed per call; fetched page content is treated as untrusted data.",
          )}
        </p>
        <SettingRow label={t("webSearchEnable", "Enable web search tools")} controlId={controlId}>
          <label
            htmlFor={controlId}
            style={{ width: 36, height: 36, display: "grid", placeItems: "center", cursor: busy ? "wait" : "pointer" }}
          >
            <Checkbox
              id={controlId}
              checked={snapshot?.settings.enabled === true}
              disabled={busy}
              onChange={(checked) => void save({ enabled: checked })}
            />
          </label>
        </SettingRow>
        <p style={hintStyle}>
          {t(
            "webSearchBilling",
            "Search and fetch are billed per successful request; failed requests are not billed. Each call is recorded in the session execution history.",
          )}
        </p>
        <p style={hintStyle}>
          {t(
            "webSearchToolsHint",
            "After enabling, grant the tools per session by choosing Full access in the session tool menu. New sessions keep their own tool choice.",
          )}
        </p>
        <div style={{ height: 1, background: "var(--border)", margin: "20px 0" }} />
        <SettingRow label={t("webSearchProvider", "Search provider")} controlId={providerControlId}>
          <Select
            id={providerControlId}
            style={{ minWidth: 180 }}
            value={providerId}
            disabled={busy}
            onChange={(value) => void switchProvider(value)}
            options={providers.map((provider) => ({ value: provider.id, label: provider.label }))}
          />
        </SettingRow>
        {activeProvider && <p style={hintStyle}>{providerHint(t, activeProvider.id, activeProvider.supportsFetch)}</p>}
        <div style={{ height: 1, background: "var(--border)", margin: "20px 0" }} />
        <SettingRow label={t("webSearchApiKeyOverride", "Dedicated API key (optional)")} controlId={keyControlId}>
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <Input
              id={keyControlId}
              style={inputStyle}
              type="password"
              autoComplete="new-password"
              placeholder={keyPlaceholder(t, providerId)}
              value={keyDraft}
              disabled={busy || testing || !providerId}
              onChange={(event) => setKeyDrafts((drafts) => ({ ...drafts, [providerId]: event.target.value }))}
            />
            <Button
              type="button"
              size="lg"
              style={{ opacity: keyDirty && !busy ? 1 : 0.6 }}
              disabled={!keyDirty || busy}
              onClick={() => void saveKey()}
            >
              {t("webSearchApiKeyOverrideSave", "Save key")}
            </Button>
            <Button
              type="button"
              size="lg"
              style={{ opacity: testing ? 0.65 : 1 }}
              disabled={busy || testing || !providerId}
              onClick={() => void test()}
            >
              {testing ? t("webSearchTesting", "Testing…") : t("webSearchTest", "Test")}
            </Button>
          </div>
        </SettingRow>
        <p style={hintStyle}>
          {credential === "override"
            ? t("webSearchCredentialOverride", "Using the dedicated key saved above.")
            : credential === "provider"
              ? t("webSearchCredentialProvider", "Using the provider API key from Settings → Models.")
              : t(
                  "webSearchCredentialNone",
                  "No key configured. Add a matching provider in Settings → Models, or save a dedicated key above.",
                )}
        </p>
        {testResult && (
          <p
            role="status"
            style={{
              ...hintStyle,
              color: testResult.ok ? "var(--text-muted)" : "var(--danger)",
              overflowWrap: "anywhere",
            }}
          >
            {testResult.ok ? "✓" : "!"} {testResult.text}
          </p>
        )}
        {error && (
          <p role="alert" style={{ ...hintStyle, color: "var(--danger)" }}>
            {error === "load"
              ? t("webSearchLoadFailed", "Web search settings could not be loaded.")
              : t("webSearchSaveFailed", "Web search settings could not be saved. The previous setting was restored.")}
          </p>
        )}
      </section>
    </div>
  );
}
