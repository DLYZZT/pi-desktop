import { useCallback, useEffect, useState } from "react";
import { call } from "@/lib/api-client";
import { useI18n } from "@/i18n";
import type {
  AdvancedModelSettings,
  AutoRoutingConfig,
  CatalogModel,
  ModelReference,
  ModelSettingsSnapshot,
} from "@contract/model-settings";
import { Field, Check, NumInput, Select, SectionTitle } from "../form-controls";
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

/** Load / edit / save state for a revision-checked settings file. */
function useVersionedSettings<T>(
  fetch: () => Promise<ModelSettingsSnapshot<T>>,
  persist: (config: T, expectedVersion: string) => Promise<ModelSettingsSnapshot<T>>,
  onChanged?: () => void,
) {
  const [config, setConfig] = useState<T>();
  const [version, setVersion] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);
  const run = useCallback(async (action: () => Promise<void>) => {
    setBusy(true);
    setError("");
    try {
      await action();
    } catch (error) {
      setError(String(error));
    } finally {
      setBusy(false);
    }
  }, []);
  const load = useCallback(
    () =>
      run(async () => {
        const snapshot = await fetch();
        setConfig(snapshot.config);
        setVersion(snapshot.version);
        setSaved(false);
      }),
    [fetch, run],
  );
  useEffect(() => {
    void load();
  }, [load]);
  const change = (update: (current: T) => T) => {
    setConfig((current) => (current ? update(current) : current));
    setSaved(false);
  };
  const save = () =>
    run(async () => {
      if (!config) return;
      const next = await persist(config, version);
      setVersion(next.version);
      setSaved(true);
      onChanged?.();
    });
  return { config, version, busy, error, saved, load, change, save };
}

function SettingsActions({
  error,
  saved,
  busy,
  canSave,
  onSave,
  onReload,
}: {
  error: string;
  saved: boolean;
  busy: boolean;
  canSave: boolean;
  onSave: () => void;
  onReload: () => void;
}) {
  const { t } = useI18n();
  return (
    <>
      {error && (
        <p role="alert" style={{ color: "#ef4444", overflowWrap: "anywhere" }}>
          {error}
        </p>
      )}
      {saved && <p role="status">{t("saved", "Saved")}</p>}
      <div style={{ display: "flex", gap: 8 }}>
        <button style={buttonStyle} disabled={busy || !canSave} onClick={onSave}>
          {t("save", "Save")}
        </button>
        <button style={buttonStyle} disabled={busy} onClick={onReload}>
          {t("reload", "Reload")}
        </button>
      </div>
    </>
  );
}

export function RoutingSettings({ cwd, onChanged }: { cwd?: string | null; onChanged?: () => void }) {
  const { t } = useI18n();
  const [models, setModels] = useState<CatalogModel[]>([]);
  const fetch = useCallback(async () => {
    const [snapshot, catalog] = await Promise.all([
      call("models.routing.get"),
      call("models.catalog", { cwd: cwd ?? undefined }),
    ]);
    setModels(catalog.models);
    return snapshot;
  }, [cwd]);
  const settings = useVersionedSettings<AutoRoutingConfig>(
    fetch,
    (config, expectedVersion) => call("models.routing.set", { config, expectedVersion, cwd: cwd ?? undefined }),
    onChanged,
  );
  const { config } = settings;
  const change = (patch: Partial<AutoRoutingConfig>) => settings.change((current) => ({ ...current, ...patch }));
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
              options={THINKING_LEVELS}
            />
          </Field>
          {chooseModel(t("modelStrongModel", "Capable model"), "strong")}
          <Field label={t("modelStrongThinking", "Capable model thinking level")}>
            <Select
              required
              value={config.strongThinking}
              onChange={(strongThinking) => change({ strongThinking })}
              options={THINKING_LEVELS}
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
      <SettingsActions
        error={settings.error}
        saved={settings.saved}
        busy={settings.busy}
        canSave={Boolean(config && settings.version)}
        onSave={() => void settings.save()}
        onReload={() => void settings.load()}
      />
    </div>
  );
}

export function AdvancedSettings({ onChanged }: { onChanged?: () => void }) {
  const { t } = useI18n();
  const [valid, setValid] = useState(true);
  const fetch = useCallback(async () => {
    const snapshot = await call("settings.advanced.get");
    setValid(true);
    return snapshot;
  }, []);
  const settings = useVersionedSettings<AdvancedModelSettings>(
    fetch,
    (config, expectedVersion) => call("settings.advanced.set", { config, expectedVersion }),
    onChanged,
  );
  const { config, version } = settings;
  const change = (next: AdvancedModelSettings) => settings.change(() => next);
  const number = (
    label: string,
    value: number | undefined,
    placeholder: number,
    update: (value: number | undefined) => void,
  ) => (
    <Field label={label}>
      <NumInput
        value={value === undefined ? "" : String(value)}
        placeholder={String(placeholder)}
        onChange={(next) => update(next === "" ? undefined : Number(next))}
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
              options={["auto", "sse", "websocket", "websocket-cached"]}
            />
          </Field>
        </>
      )}
      <SettingsActions
        error={settings.error}
        saved={settings.saved}
        busy={settings.busy}
        canSave={Boolean(config && version && valid)}
        onSave={() => void settings.save()}
        onReload={() => void settings.load()}
      />
    </div>
  );
}
