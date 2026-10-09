import { useCallback, useEffect, useState } from "react";
import { call } from "@/lib/api-client";
import { useI18n } from "@/i18n";
import type { AdvancedModelSettings, AutoRoutingConfig, CatalogModel, ModelReference } from "@contract/model-settings";
import { Field, Check, Select, SectionTitle } from "../form-controls";
import { JsonObjectField } from "./JsonObjectField";
import { THINKING_LEVELS } from "@shared/thinking-levels";

const buttonStyle = {
  padding: "7px 12px",
  border: "1px solid var(--border)",
  borderRadius: 5,
  background: "var(--bg-panel)",
  color: "var(--text)",
  cursor: "pointer",
};

export function RoutingSettings({ cwd, onChanged }: { cwd?: string | null; onChanged?: () => void }) {
  const { t } = useI18n();
  const [config, setConfig] = useState<AutoRoutingConfig>();
  const [version, setVersion] = useState("");
  const [models, setModels] = useState<CatalogModel[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const load = useCallback(async () => {
    setBusy(true);
    setError("");
    try {
      const [snapshot, catalog] = await Promise.all([
        call("models.routing.get"),
        call("models.catalog", { cwd: cwd ?? undefined }),
      ]);
      setConfig(snapshot.config);
      setVersion(snapshot.version);
      setModels(catalog.models);
      setSaved(false);
    } catch (error) {
      setError(String(error));
    } finally {
      setBusy(false);
    }
  }, [cwd]);
  useEffect(() => {
    void load();
  }, [load]);
  const change = (patch: Partial<AutoRoutingConfig>) => {
    setConfig((current) => (current ? { ...current, ...patch } : current));
    setSaved(false);
  };
  const chooseModel = (label: string, role: "fast" | "strong" | "classifier") => {
    const choices = models.filter(
      (model) => !model.virtual && model.available && model.type === (role === "classifier" ? "classifier" : "chat"),
    );
    const reference = config?.[role];
    const key = (ref: ModelReference) => JSON.stringify([ref.provider, ref.modelId]);
    const value = reference ? key(reference) : "";
    return (
      <Field label={label}>
        <Select
          required
          value={value}
          onChange={(value) => {
            const [provider, modelId] = value ? JSON.parse(value) : [];
            change({ [role]: value ? { provider, modelId } : undefined });
          }}
          options={[
            { value: "", label: t("modelChooseAvailable", "Select an available model") },
            ...(reference && !choices.some((model) => key(model) === value)
              ? [
                  {
                    value,
                    label: `${reference.provider}/${reference.modelId} (${t("modelUnavailable", "Unavailable")})`,
                  },
                ]
              : []),
            ...choices.map((model) => ({
              value: key(model),
              label: `${model.name} · ${model.provider}/${model.modelId}`,
            })),
          ]}
        />
      </Field>
    );
  };
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <SectionTitle>{t("modelAutoRouting", "Auto routing")}</SectionTitle>
      <p style={{ color: "var(--text-muted)", fontSize: 12, lineHeight: 1.6, margin: 0 }}>
        {t(
          "modelRoutingHelp",
          "Choose Auto in the chat model picker after saving. Each new user turn selects a model; tool continuations keep it. Changes apply to new or reloaded sessions, or when Auto is selected again.",
        )}
      </p>
      {config && (
        <>
          <Check
            checked={config.enabled}
            onChange={(enabled) => change({ enabled })}
            label={t("modelEnableAuto", "Enable Auto")}
          />
          <Field label={t("modelRoutingStrategy", "Routing strategy")}>
            <Select
              required
              value={config.strategy}
              onChange={(strategy) => change({ strategy: strategy as AutoRoutingConfig["strategy"] })}
              options={[
                {
                  value: "thinking",
                  label: t("modelRouteThinking", "By thinking level: high and above use the capable model"),
                },
                { value: "classifier", label: t("modelRouteClassifier", "Decision model judges task complexity") },
              ]}
            />
          </Field>
          {chooseModel(t("modelFastModel", "Fast model"), "fast")}
          <Field label={t("modelFastThinking", "Fast model thinking level")}>
            <Select
              required
              value={config.fastThinking}
              onChange={(fastThinking) => change({ fastThinking })}
              options={THINKING_LEVELS.map((value) => ({ value, label: value }))}
            />
          </Field>
          {chooseModel(t("modelStrongModel", "Capable model"), "strong")}
          <Field label={t("modelStrongThinking", "Capable model thinking level")}>
            <Select
              required
              value={config.strongThinking}
              onChange={(strongThinking) => change({ strongThinking })}
              options={THINKING_LEVELS.map((value) => ({ value, label: value }))}
            />
          </Field>
          {config.strategy === "classifier" && (
            <>
              {chooseModel(t("modelDecision", "Decision"), "classifier")}
              <p style={{ color: "var(--text-muted)", fontSize: 12 }}>
                {t(
                  "modelClassifierFallback",
                  "The decision request adds latency and usage. If it fails, Auto uses the capable model. Thinking levels are limited to what the selected model supports.",
                )}
              </p>
            </>
          )}
          <Check
            checked={config.retryFallback}
            onChange={(retryFallback) => change({ retryFallback })}
            label={t("modelRetryFallback", "Try the other configured model on an automatic retry")}
          />
        </>
      )}
      {error && (
        <p role="alert" style={{ color: "#ef4444", overflowWrap: "anywhere" }}>
          {error}
        </p>
      )}
      {saved && <p role="status">{t("saved", "Saved")}</p>}
      <div style={{ display: "flex", gap: 8 }}>
        <button
          style={buttonStyle}
          disabled={busy || !config || !version}
          onClick={async () => {
            if (!config) return;
            setBusy(true);
            setError("");
            try {
              const next = await call("models.routing.set", {
                config,
                expectedVersion: version,
                cwd: cwd ?? undefined,
              });
              setVersion(next.version);
              setSaved(true);
              onChanged?.();
            } catch (error) {
              setError(String(error));
            } finally {
              setBusy(false);
            }
          }}
        >
          {t("save", "Save")}
        </button>
        <button style={buttonStyle} disabled={busy} onClick={() => void load()}>
          {t("reload", "Reload")}
        </button>
      </div>
    </div>
  );
}

export function AdvancedSettings({ onChanged }: { onChanged?: () => void }) {
  const { t } = useI18n();
  const [config, setConfig] = useState<AdvancedModelSettings>();
  const [version, setVersion] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [valid, setValid] = useState(true);
  const [saved, setSaved] = useState(false);
  const load = useCallback(async () => {
    setBusy(true);
    setError("");
    try {
      const next = await call("settings.advanced.get");
      setConfig(next.config);
      setVersion(next.version);
      setValid(true);
      setSaved(false);
    } catch (error) {
      setError(String(error));
    } finally {
      setBusy(false);
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);
  const change = (next: AdvancedModelSettings) => {
    setConfig(next);
    setSaved(false);
  };
  const number = (
    label: string,
    value: number | undefined,
    placeholder: number,
    update: (value: number | undefined) => void,
  ) => (
    <Field label={label}>
      <input
        aria-label={label}
        type="number"
        min={0}
        step={1}
        value={value ?? ""}
        placeholder={String(placeholder)}
        onChange={(event) => update(event.target.value === "" ? undefined : Number(event.target.value))}
        style={{ ...buttonStyle, cursor: "text" }}
      />
    </Field>
  );
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <SectionTitle>{t("modelAdvancedSettings", "Advanced model settings")}</SectionTitle>
      <p style={{ color: "var(--text-muted)", fontSize: 12, lineHeight: 1.6, margin: 0 }}>
        {t(
          "modelAdvancedHelp",
          "Global Pi settings, shared with the CLI. Empty values use Pi defaults. Trusted project settings may override them. Reload existing sessions to apply changes.",
        )}
      </p>
      {config && (
        <>
          <Check
            checked={config.compaction?.enabled ?? true}
            onChange={(enabled) => change({ ...config, compaction: { ...config.compaction, enabled } })}
            label={t("modelAutoCompaction", "Automatic context compaction")}
          />
          {number(
            t("modelReserveTokens", "Response token reserve"),
            config.compaction?.reserveTokens,
            16384,
            (reserveTokens) => change({ ...config, compaction: { ...config.compaction, reserveTokens } }),
          )}
          {number(
            t("modelKeepRecentTokens", "Recent tokens to keep"),
            config.compaction?.keepRecentTokens,
            20000,
            (keepRecentTokens) => change({ ...config, compaction: { ...config.compaction, keepRecentTokens } }),
          )}
          <JsonObjectField
            key={version}
            label={t("modelCompactionOverrides", "Compaction overrides by provider/modelId (JSON)")}
            value={config.compaction?.modelOverrides}
            example={JSON.stringify({ "provider/modelId": { reserveTokens: 16384, keepRecentTokens: 20000 } }, null, 2)}
            onValidityChange={setValid}
            onChange={(modelOverrides) =>
              change({
                ...config,
                compaction: {
                  ...config.compaction,
                  modelOverrides: modelOverrides as NonNullable<AdvancedModelSettings["compaction"]>["modelOverrides"],
                },
              })
            }
          />
          <Check
            checked={config.retry?.enabled ?? true}
            onChange={(enabled) => change({ ...config, retry: { ...config.retry, enabled } })}
            label={t("modelAutoRetry", "Automatic retries")}
          />
          {number(t("modelRetryCount", "Agent retry count"), config.retry?.maxRetries, 3, (maxRetries) =>
            change({ ...config, retry: { ...config.retry, maxRetries } }),
          )}
          {number(t("modelRetryDelay", "Initial retry delay (ms)"), config.retry?.baseDelayMs, 2000, (baseDelayMs) =>
            change({ ...config, retry: { ...config.retry, baseDelayMs } }),
          )}
          {number(
            t("modelMaxRetryDelay", "Maximum agent retry delay (ms)"),
            config.retry?.maxAgentDelayMs,
            60000,
            (maxAgentDelayMs) => change({ ...config, retry: { ...config.retry, maxAgentDelayMs } }),
          )}
          {number(
            t("modelRequestTimeout", "Provider request timeout (ms; 0 disables)"),
            config.retry?.provider?.timeoutMs,
            300000,
            (timeoutMs) =>
              change({ ...config, retry: { ...config.retry, provider: { ...config.retry?.provider, timeoutMs } } }),
          )}
          {number(
            t("modelProviderRetries", "Provider retry count"),
            config.retry?.provider?.maxRetries,
            0,
            (maxRetries) =>
              change({ ...config, retry: { ...config.retry, provider: { ...config.retry?.provider, maxRetries } } }),
          )}
          {number(
            t("modelProviderRetryDelay", "Maximum provider retry delay (ms; 0 disables)"),
            config.retry?.provider?.maxRetryDelayMs,
            60000,
            (maxRetryDelayMs) =>
              change({
                ...config,
                retry: { ...config.retry, provider: { ...config.retry?.provider, maxRetryDelayMs } },
              }),
          )}
          <Field label={t("modelTransport", "Provider transport")}>
            <Select
              required
              value={config.transport ?? "auto"}
              onChange={(transport) =>
                change({ ...config, transport: transport as AdvancedModelSettings["transport"] })
              }
              options={["auto", "sse", "websocket", "websocket-cached"].map((value) => ({ value, label: value }))}
            />
          </Field>
        </>
      )}
      {error && (
        <p role="alert" style={{ color: "#ef4444" }}>
          {error}
        </p>
      )}
      {saved && <p role="status">{t("saved", "Saved")}</p>}
      <div style={{ display: "flex", gap: 8 }}>
        <button
          style={buttonStyle}
          disabled={busy || !config || !version || !valid}
          onClick={async () => {
            if (!config) return;
            setBusy(true);
            setError("");
            try {
              const next = await call("settings.advanced.set", { config, expectedVersion: version });
              setVersion(next.version);
              setSaved(true);
              onChanged?.();
            } catch (error) {
              setError(String(error));
            } finally {
              setBusy(false);
            }
          }}
        >
          {t("save", "Save")}
        </button>
        <button style={buttonStyle} disabled={busy} onClick={() => void load()}>
          {t("reload", "Reload")}
        </button>
      </div>
    </div>
  );
}
