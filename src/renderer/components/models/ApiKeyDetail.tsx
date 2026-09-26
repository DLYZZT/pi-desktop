import { useState, useEffect, useCallback } from "react";
import { Field, SecretTextInput, SectionTitle, TextInput } from "../form-controls";
import { useI18n } from "@/i18n";
import { call } from "@/lib/api-client";
import type { ApiKeyProviderStatus as ApiKeyProvider } from "@contract/types";
import { type ModelSelectionControl, ManagedModelsControl } from "./ManagedModelsControl";

export function ApiKeyDetail({
  provider,
  baseUrl,
  onBaseUrlChange,
  onRefresh,
  modelSelection,
}: {
  provider: ApiKeyProvider;
  baseUrl: string;
  onBaseUrlChange: (baseUrl: string) => void;
  onRefresh: () => void;
  modelSelection: ModelSelectionControl;
}) {
  const { t } = useI18n();
  const [apiKey, setApiKey] = useState("");
  const [saving, setSaving] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [warning, setWarning] = useState<string | null>(null);
  const [savedOk, setSavedOk] = useState(false);

  // Reset state when provider changes
  useEffect(() => {
    setApiKey("");
    setError(null);
    setWarning(null);
    setSavedOk(false);
  }, [provider.id]);

  const handleSave = useCallback(async () => {
    if (!apiKey.trim()) return;
    setSaving(true);
    setError(null);
    setWarning(null);
    setSavedOk(false);
    try {
      const result = await call("auth.setApiKey", { provider: provider.id, key: apiKey.trim() });
      setApiKey("");
      setSavedOk(true);
      setWarning(result.warning?.message ?? null);
      setTimeout(() => setSavedOk(false), 2000);
      onRefresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }, [apiKey, provider.id, onRefresh]);

  const handleRemove = useCallback(async () => {
    setRemoving(true);
    setError(null);
    setWarning(null);
    try {
      const result = await call("auth.deleteApiKey", { provider: provider.id });
      setWarning(result.warning?.message ?? null);
      onRefresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setRemoving(false);
    }
  }, [provider.id, onRefresh]);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <SectionTitle>{t("modelApiKey", "API Key")}</SectionTitle>
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <span
            style={{
              width: 7,
              height: 7,
              borderRadius: "50%",
              background: provider.configured ? "#4ade80" : "var(--border)",
              display: "inline-block",
            }}
          />
          <span style={{ fontSize: 11, color: provider.configured ? "#4ade80" : "var(--text-dim)" }}>
            {provider.configured ? t("configured", "configured") : t("notConfigured", "not configured")}
          </span>
        </div>
      </div>

      <p style={{ margin: 0, fontSize: 12, color: "var(--text-muted)", lineHeight: 1.5 }}>
        {provider.configured
          ? t(
              "modelApiKeyStored",
              "API key is stored. Enter a new key below to replace it, or disconnect to remove it.",
            )
          : t("modelEnterApiKey", "Enter your {provider} API key to enable {count} models.")
              .replace("{provider}", provider.displayName)
              .replace("{count}", String(provider.modelCount))}
      </p>

      <Field label={t("modelBaseUrl", "Base URL")}>
        <TextInput
          value={baseUrl}
          onChange={onBaseUrlChange}
          placeholder={t("modelBaseUrlPlaceholder", "Leave empty to use the provider default")}
          mono
        />
        <span style={{ fontSize: 10, color: "var(--text-dim)", marginTop: 2 }}>
          {t(
            "modelBaseUrlHint",
            "Overrides the endpoint for this provider. Use the Save button below to apply changes.",
          )}
        </span>
      </Field>

      <Field label={t("modelApiKey", "API Key")}>
        <div style={{ display: "flex", gap: 6 }}>
          <SecretTextInput
            value={apiKey}
            onChange={setApiKey}
            onKeyDown={(e) => {
              if (e.key === "Enter" && apiKey.trim()) void handleSave();
            }}
            placeholder={provider.configured ? t("modelReplaceApiKey", "Enter new key to replace…") : "sk-…"}
            style={{ flex: 1 }}
            autoComplete="off"
            spellCheck={false}
            mono
          />
          <button
            onClick={handleSave}
            disabled={saving || !apiKey.trim() || savedOk}
            style={{
              padding: "6px 12px",
              background: savedOk ? "#16a34a" : apiKey.trim() ? "var(--accent)" : "var(--bg-panel)",
              border: "none",
              borderRadius: 5,
              color: apiKey.trim() || savedOk ? "#fff" : "var(--text-dim)",
              cursor: saving || !apiKey.trim() || savedOk ? "not-allowed" : "pointer",
              fontSize: 12,
              fontWeight: 600,
              flexShrink: 0,
              display: "flex",
              alignItems: "center",
              gap: 5,
            }}
          >
            {savedOk && (
              <svg
                width="12"
                height="12"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="3"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <polyline points="20 6 9 17 4 12" />
              </svg>
            )}
            {savedOk ? t("saved", "Saved") : saving ? t("saving", "Saving…") : t("save", "Save")}
          </button>
        </div>
      </Field>

      {error && <p style={{ margin: 0, fontSize: 12, color: "#f87171" }}>{error}</p>}
      {warning && <p style={{ margin: 0, fontSize: 12, color: "#d97706" }}>{warning}</p>}

      {provider.configured && <ManagedModelsControl providerId={provider.id} {...modelSelection} />}

      {provider.configured && (
        <button
          onClick={handleRemove}
          disabled={removing}
          style={{
            alignSelf: "flex-start",
            padding: "5px 12px",
            background: "none",
            border: "1px solid rgba(239,68,68,0.3)",
            borderRadius: 5,
            color: "#ef4444",
            cursor: removing ? "not-allowed" : "pointer",
            fontSize: 12,
          }}
        >
          {removing ? t("modelRemoving", "Removing…") : t("modelDisconnect", "Disconnect")}
        </button>
      )}
    </div>
  );
}
