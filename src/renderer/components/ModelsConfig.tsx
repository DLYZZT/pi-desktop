import { RoutingSettings, AdvancedSettings } from "./models/ModelSettings";
import { useState, useEffect, useCallback, useReducer, useRef } from "react";
import { useIsMobile } from "@/hooks/useIsMobile";
import { useI18n } from "@/i18n";
import { oauthProviderName } from "./models/provider-display";
import {
  addModelTransition,
  applyProviderNameDrafts,
  deleteProviderTransition,
  modelsConfigEditorReducer,
  replaceModelEntry,
  selectionAfterProviderRename,
  setProviderBaseUrl,
  type ModelEntry,
  type ModelsConfigSelection,
  type ModelsConfigUpdate,
  type ModelsJson,
  type ProviderEntry,
} from "@/lib/models-config-state";
import { call, getModelPreferences, setModelPreferences } from "@/lib/api-client";
import type {
  ModelPreferencesResult,
  ProviderStatus as OAuthProvider,
  ApiKeyProviderStatus as ApiKeyProvider,
  AzureUpgradeReport,
  ModelsConfigIssue,
} from "@contract/types";
import { ProviderDetail, ModelDetail, ModelOverridesField } from "./models/ModelForms";
import { ProviderIcon } from "./models/ProviderIcon";
import { CustomProviderTree } from "./models/CustomProviderTree";
import "./models/custom-model-settings.css";
import { OAuthDetail } from "./models/OAuthDetail";
import { ApiKeyDetail } from "./models/ApiKeyDetail";
import { AddProviderPicker } from "./models/AddProviderPicker";
import { AzureUpgradeNotice } from "./models/AzureUpgradeNotice";

type Selection = ModelsConfigSelection;

export function ModelsConfig({
  onClose,
  onChanged,
  embedded = false,
  cwd = null,
}: {
  onClose: () => void;
  onChanged?: () => void;
  embedded?: boolean;
  cwd?: string | null;
}) {
  const isMobile = useIsMobile();
  const { t } = useI18n();
  const [{ config, selection, providerNameDrafts = {} }, dispatchEditor] = useReducer(modelsConfigEditorReducer, {
    config: { providers: {} },
    selection: null,
  });
  const [modelFormValid, setModelFormValid] = useState(true);
  const setConfig = useCallback((update: ModelsConfigUpdate) => dispatchEditor({ type: "config.update", update }), []);
  const setSelection = useCallback((nextSelection: Selection | null) => {
    setModelFormValid(true);
    dispatchEditor({ type: "selection.set", selection: nextSelection });
  }, []);
  const [configVersion, setConfigVersion] = useState<string | null>(null);
  const [savedConfigJson, setSavedConfigJson] = useState<string | null>(null);
  const pendingProviderRenames = useRef<Record<string, string>>({});
  const [azureUpgrade, setAzureUpgrade] = useState<AzureUpgradeReport>();
  const [configIssues, setConfigIssues] = useState<ModelsConfigIssue[]>([]);
  const [configWarnings, setConfigWarnings] = useState<ModelsConfigIssue[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saveConflict, setSaveConflict] = useState(false);
  const [savedOk, setSavedOk] = useState(false);
  const [oauthProviders, setOauthProviders] = useState<OAuthProvider[]>([]);
  const [apiKeyProviders, setApiKeyProviders] = useState<ApiKeyProvider[]>([]);
  const [modelPreferences, setModelPreferencesState] = useState<ModelPreferencesResult | null>(null);
  const [modelPreferencesLoading, setModelPreferencesLoading] = useState(true);
  const [modelPreferencesSaving, setModelPreferencesSaving] = useState(false);
  const [modelPreferencesError, setModelPreferencesError] = useState<string | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const addProviderButtonRef = useRef<HTMLButtonElement>(null);

  const loadOAuthProviders = useCallback(() => {
    call("auth.providers")
      .then((d) => setOauthProviders(d.providers))
      .catch(() => {});
  }, []);

  const loadApiKeyProviders = useCallback(() => {
    call("auth.allProviders")
      .then((d) => setApiKeyProviders(d.providers))
      .catch(() => {});
  }, []);

  const loadModelPreferences = useCallback(async () => {
    setModelPreferencesLoading(true);
    setModelPreferencesError(null);
    try {
      setModelPreferencesState(await getModelPreferences(cwd ?? undefined));
    } catch (error) {
      setModelPreferencesError(error instanceof Error ? error.message : String(error));
    } finally {
      setModelPreferencesLoading(false);
    }
  }, [cwd]);

  const updateModelPreferences = useCallback(
    async (enabledModels: string[] | null) => {
      setModelPreferencesSaving(true);
      setModelPreferencesError(null);
      try {
        const result = await setModelPreferences(cwd ?? undefined, enabledModels);
        setModelPreferencesState(result);
        onChanged?.();
      } catch (error) {
        setModelPreferencesError(error instanceof Error ? error.message : String(error));
      } finally {
        setModelPreferencesSaving(false);
      }
    },
    [cwd, onChanged],
  );

  const refreshOAuthProviders = useCallback(() => {
    loadOAuthProviders();
    loadApiKeyProviders();
    void loadModelPreferences();
    onChanged?.();
  }, [loadModelPreferences, loadOAuthProviders, loadApiKeyProviders, onChanged]);

  const refreshApiKeyProviders = useCallback(() => {
    loadApiKeyProviders();
    loadOAuthProviders();
    void loadModelPreferences();
    onChanged?.();
  }, [loadApiKeyProviders, loadOAuthProviders, loadModelPreferences, onChanged]);

  const reloadCredentials = useCallback(() => {
    loadOAuthProviders();
    loadApiKeyProviders();
  }, [loadOAuthProviders, loadApiKeyProviders]);

  const [loadFailed, setLoadFailed] = useState(false);
  const [configLoaded, setConfigLoaded] = useState(false);

  const loadModelsConfig = useCallback(async () => {
    setLoading(true);
    setLoadFailed(false);
    setConfigLoaded(false);
    try {
      const snapshot = await call("modelsConfig.get");
      if (!snapshot.config || typeof snapshot.version !== "string") throw new Error("Invalid models config snapshot");
      // Host owns complete SDK JSON; the editor works on its provider/model subset.
      const editorConfig = snapshot.config as ModelsJson;
      const normalized = editorConfig.providers ? editorConfig : { ...editorConfig, providers: {} };
      const keys = Object.keys(normalized.providers ?? {});
      setModelFormValid(true);
      dispatchEditor({
        type: "config.replace",
        config: normalized,
        selection: keys.length > 0 ? { type: "provider", name: keys[0] } : null,
      });
      setConfigVersion(snapshot.version);
      setSavedConfigJson(JSON.stringify(normalized));
      pendingProviderRenames.current = {};
      setAzureUpgrade(snapshot.azureUpgrade);
      setConfigIssues(snapshot.issues ?? []);
      setConfigWarnings(snapshot.warnings ?? []);
      setConfigLoaded(true);
      setSaveConflict(false);
      setSaveError(null);
    } catch (error) {
      setLoadFailed(true);
      setSaveError(error instanceof Error ? error.message : String(error));
      // Do NOT reset to empty providers — keep prior state / block save
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadModelsConfig();
    loadOAuthProviders();
    loadApiKeyProviders();
  }, [loadApiKeyProviders, loadModelsConfig, loadOAuthProviders]);

  useEffect(() => {
    void loadModelPreferences();
  }, [loadModelPreferences]);

  const addCustomProvider = useCallback(() => {
    setModelFormValid(true);
    dispatchEditor({ type: "provider.addCustom" });
  }, []);

  const updateProvider = useCallback(
    (name: string, p: ProviderEntry) => {
      setConfig((prev) => ({ ...prev, providers: { ...(prev.providers ?? {}), [name]: p } }));
    },
    [setConfig],
  );

  const deleteProvider = useCallback(
    (name: string) => {
      const transition = deleteProviderTransition(config, selection, name);
      setConfig(transition.config);
      setSelection(transition.selection);
    },
    [config, selection, setConfig, setSelection],
  );

  const addModel = useCallback(
    (providerName: string) => {
      const transition = addModelTransition(config, providerName);
      setConfig(transition.config);
      setSelection(transition.selection);
    },
    [config, setConfig, setSelection],
  );

  const updateModel = useCallback(
    (providerName: string, index: number, m: ModelEntry) => {
      setConfig((prev) => replaceModelEntry(prev, providerName, index, m));
    },
    [setConfig],
  );

  const removeModel = useCallback(
    (providerName: string, index: number) => {
      setConfig((prev) => {
        const provider = prev.providers?.[providerName] ?? {};
        const models = [...(provider.models ?? [])];
        models.splice(index, 1);
        return {
          ...prev,
          providers: {
            ...(prev.providers ?? {}),
            [providerName]: { ...provider, models: models.length ? models : undefined },
          },
        };
      });
      setSelection({ type: "provider", name: providerName });
    },
    [setConfig, setSelection],
  );

  const preparedNames = applyProviderNameDrafts(config, providerNameDrafts);
  const nameError = preparedNames.ok
    ? undefined
    : preparedNames.reason === "empty"
      ? t("modelProviderNameRequired", "Provider name cannot be empty.")
      : preparedNames.reason === "reserved"
        ? t("modelProviderNameReserved", "Provider name “{name}” is reserved.").replace("{name}", preparedNames.name)
        : t("modelProviderNameTaken", "Provider name “{name}” already exists.").replace("{name}", preparedNames.name);

  const handleSave = async () => {
    if (!configVersion || !modelFormValid || !preparedNames.ok) return;
    const nextConfig = preparedNames.config;
    const pending = pendingProviderRenames.current;
    const renames = Object.fromEntries(
      Object.entries(pending).map(([from, to]) => [
        from,
        Object.hasOwn(preparedNames.renames, to) ? preparedNames.renames[to] : to,
      ]),
    );
    for (const [from, to] of Object.entries(preparedNames.renames))
      if (!Object.values(pending).includes(from)) renames[from] = to;
    const savedProviders = savedConfigJson ? ((JSON.parse(savedConfigJson) as ModelsJson).providers ?? {}) : {};
    for (const from of Object.keys(renames))
      if (
        renames[from] === from ||
        !Object.hasOwn(savedProviders, from) ||
        !Object.hasOwn(nextConfig.providers ?? {}, renames[from])
      )
        delete renames[from];
    pendingProviderRenames.current = renames;
    const selectedProvider =
      selection?.type === "provider"
        ? selection.name
        : selection?.type === "model"
          ? selection.providerName
          : undefined;
    const nextSelection =
      selectedProvider && Object.hasOwn(preparedNames.renames, selectedProvider)
        ? selectionAfterProviderRename(selection, selectedProvider, preparedNames.renames[selectedProvider])
        : selection;
    // Apply to the editor draft first. Failed writes retain the rename for a normal Save retry.
    dispatchEditor({ type: "config.replace", config: nextConfig, selection: nextSelection });
    setSaving(true);
    setSaveError(null);
    setSavedOk(false);
    try {
      const result = await call("modelsConfig.set", {
        config: nextConfig,
        expectedVersion: configVersion,
        ...(Object.keys(renames).length ? { providerRenames: renames } : {}),
      });
      if (typeof result.version !== "string") {
        setSaveError("Invalid models config save response");
      } else {
        setConfigVersion(result.version);
        pendingProviderRenames.current = {};
        setSavedConfigJson(JSON.stringify(nextConfig));
        setConfigIssues([]);
        setConfigWarnings(result.warnings ?? []);
        setSaveConflict(false);
        setSavedOk(true);
        onChanged?.();
        void loadModelPreferences();
        setTimeout(() => setSavedOk(false), 2000);
      }
    } catch (error) {
      const conflict = error instanceof Error && "code" in error && error.code === "CONFLICT";
      setSaveConflict(conflict);
      setSaveError(
        conflict
          ? t(
              "modelConfigConflict",
              "models.json changed outside this editor. Your edits are preserved here; copy or compare them before reloading the disk version to merge manually.",
            )
          : error instanceof Error
            ? error.message
            : String(error),
      );
    } finally {
      setSaving(false);
    }
  };

  const providers = Object.entries(config.providers ?? {});
  const configDirty =
    savedConfigJson !== null &&
    (JSON.stringify(config) !== savedConfigJson || Object.keys(providerNameDrafts).length > 0);
  const saveDisabled =
    !modelFormValid ||
    !preparedNames.ok ||
    saving ||
    savedOk ||
    loading ||
    loadFailed ||
    saveConflict ||
    !configLoaded ||
    !configVersion;
  useEffect(() => {
    if (configDirty && savedOk) setSavedOk(false);
  }, [configDirty, savedOk]);
  const activeOAuth = oauthProviders.filter((p) => p.loggedIn);
  const activeApiKey = apiKeyProviders.filter((p) => p.configured);

  const providerOverrides = (id: string) => (
    <ModelOverridesField
      key={`${id}:${configVersion}`}
      value={config.providers?.[id]?.modelOverrides}
      onValidityChange={setModelFormValid}
      onChange={(modelOverrides) =>
        setConfig((current) => ({
          ...current,
          providers: { ...current.providers, [id]: { ...current.providers?.[id], modelOverrides } },
        }))
      }
    />
  );

  // Resolve current detail
  const detailContent = (() => {
    if (!selection) return null;
    if (selection.type === "routing") return <RoutingSettings cwd={cwd} onChanged={onChanged} />;
    if (selection.type === "advanced") return <AdvancedSettings onChanged={onChanged} />;
    if (selection.type === "oauth") {
      const p = oauthProviders.find((p) => p.id === selection.providerId);
      if (!p) return null;
      return (
        <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
          <OAuthDetail
            key={p.id}
            provider={p}
            onRefresh={refreshOAuthProviders}
            onReloadCredentials={reloadCredentials}
            modelSelection={{
              preferences: modelPreferences,
              loading: modelPreferencesLoading,
              saving: modelPreferencesSaving,
              error: modelPreferencesError,
              onChange: updateModelPreferences,
            }}
          />
          {providerOverrides(p.id)}
        </div>
      );
    }
    if (selection.type === "apikey") {
      const p = apiKeyProviders.find((p) => p.id === selection.providerId);
      if (!p) return null;
      return (
        <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
          <ApiKeyDetail
            key={p.id}
            provider={p}
            baseUrl={config.providers?.[p.id]?.baseUrl ?? ""}
            onBaseUrlChange={(baseUrl) => setConfig((prev) => setProviderBaseUrl(prev, p.id, baseUrl))}
            onRefresh={refreshApiKeyProviders}
            onReloadCredentials={reloadCredentials}
            modelSelection={{
              preferences: modelPreferences,
              loading: modelPreferencesLoading,
              saving: modelPreferencesSaving,
              error: modelPreferencesError,
              onChange: updateModelPreferences,
            }}
          />
          {providerOverrides(p.id)}
        </div>
      );
    }
    if (selection.type === "provider") {
      const provider = config.providers?.[selection.name];
      if (!provider) return null;
      return (
        <ProviderDetail
          key={`${selection.name}:${configVersion}`}
          name={selection.name}
          provider={provider}
          onChange={(p) => updateProvider(selection.name, p)}
          nameDraft={
            Object.hasOwn(providerNameDrafts, selection.name) ? providerNameDrafts[selection.name] : selection.name
          }
          onNameChange={(value) => dispatchEditor({ type: "provider.name.set", name: selection.name, value })}
          nameError={!preparedNames.ok && preparedNames.provider === selection.name ? nameError : undefined}
          onDelete={() => deleteProvider(selection.name)}
          onAddModel={() => addModel(selection.name)}
          onValidityChange={setModelFormValid}
          modelSelection={{
            preferences: modelPreferences,
            loading: modelPreferencesLoading,
            saving: modelPreferencesSaving,
            error: modelPreferencesError,
            onChange: updateModelPreferences,
          }}
        />
      );
    }
    const provider = config.providers?.[selection.providerName];
    const model = provider?.models?.[selection.index];
    if (!model) return null;
    return (
      <ModelDetail
        key={`${selection.providerName}-${selection.index}-${configVersion}`}
        providerName={selection.providerName}
        provider={provider}
        model={model}
        onValidityChange={setModelFormValid}
        onChange={(m) => updateModel(selection.providerName, selection.index, m)}
        onDelete={() => removeModel(selection.providerName, selection.index)}
      />
    );
  })();

  return (
    <>
      <div
        style={
          embedded
            ? { position: "relative", flex: 1, minWidth: 0, minHeight: 0, display: "flex" }
            : {
                position: "fixed",
                inset: 0,
                zIndex: 1000,
                background: "rgba(0,0,0,0.35)",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
              }
        }
        onClick={(e) => {
          if (!embedded && e.target === e.currentTarget) onClose();
        }}
      >
        <div
          style={
            embedded
              ? {
                  width: "100%",
                  height: "100%",
                  background: "var(--bg)",
                  display: "flex",
                  flexDirection: "column",
                  overflow: "hidden",
                }
              : {
                  width: isMobile ? "calc(100vw - 16px)" : 860,
                  maxWidth: "calc(100vw - 16px)",
                  height: isMobile ? "calc(100dvh - 16px)" : "78vh",
                  maxHeight: "calc(100dvh - 16px)",
                  background: "var(--bg)",
                  border: "1px solid var(--border)",
                  borderRadius: 10,
                  display: "flex",
                  flexDirection: "column",
                  boxShadow: "0 8px 32px rgba(0,0,0,0.18)",
                  overflow: "hidden",
                }
          }
        >
          {/* Header */}
          {!embedded && (
            <div
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                padding: "12px 18px",
                borderBottom: "1px solid var(--border)",
                flexShrink: 0,
              }}
            >
              <div style={{ display: "flex", alignItems: "baseline", gap: 10 }}>
                <span style={{ fontSize: 15, fontWeight: 700, color: "var(--text)" }}>{t("models", "Models")}</span>
                <code style={{ fontSize: 11, color: "var(--text-muted)", fontFamily: "var(--font-mono)" }}>
                  ~/.pi/agent/models.json
                </code>
              </div>
              <button
                type="button"
                onClick={onClose}
                title={t("modelCloseModels", "Close models")}
                aria-label={t("modelCloseModels", "Close models")}
                style={{
                  background: "none",
                  border: "none",
                  color: "var(--text-muted)",
                  cursor: "pointer",
                  fontSize: 20,
                  lineHeight: 1,
                  width: 36,
                  height: 36,
                  padding: 0,
                  borderRadius: 7,
                }}
              >
                ×
              </button>
            </div>
          )}

          <AzureUpgradeNotice report={azureUpgrade} />
          {configIssues.length > 0 && (
            <div
              role="alert"
              style={{ padding: "10px 18px", color: "var(--error, #f87171)", maxHeight: 180, overflow: "auto" }}
            >
              <p>
                {t(
                  "modelConfigInvalidInSettings",
                  "The saved models.json is invalid. All custom providers and overrides are inactive. Correct the editable fields here; for other fields, edit models.json manually and reload the disk version. Reload the session after repairing the configuration.",
                )}
              </p>
              <ul>
                {configIssues.map((issue, index) => (
                  <li key={`${issue.path}:${index}`}>
                    <code>{issue.path}</code>: {issue.message}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {configWarnings.length > 0 && (
            <div
              role="status"
              style={{ padding: "10px 18px", color: "var(--warning)", maxHeight: 180, overflow: "auto" }}
            >
              <p>
                {configIssues.length > 0
                  ? t(
                      "modelConfigCompatibilityWarningsAfterRepair",
                      "After repairing the configuration above, also review these settings; they may not work with the current Pi runtime.",
                    )
                  : t(
                      "modelConfigCompatibilityWarnings",
                      "These settings are valid and remain active, but may not work with the current Pi runtime. Review them before relying on these providers.",
                    )}
              </p>
              <ul>
                {configWarnings.map((warning, index) => (
                  <li key={`${warning.path}:${index}`}>
                    <code>{warning.path}</code>: {warning.message}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {/* Body */}
          <div style={{ flex: 1, display: "flex", flexDirection: isMobile ? "column" : "row", overflow: "hidden" }}>
            {/* Left: tree */}
            <div
              style={{
                width: isMobile ? "100%" : 210,
                maxHeight: isMobile ? "40vh" : undefined,
                borderRight: isMobile ? "none" : "1px solid var(--border)",
                borderBottom: isMobile ? "1px solid var(--border)" : "none",
                display: "flex",
                flexDirection: "column",
                flexShrink: 0,
                background: "var(--bg-panel)",
              }}
            >
              <div style={{ flex: 1, overflowY: "auto", padding: "8px 6px" }}>
                {(["routing", "advanced"] as const).map((type) => (
                  <button
                    key={type}
                    type="button"
                    onClick={() => setSelection({ type })}
                    style={{
                      display: "block",
                      width: "100%",
                      textAlign: "left",
                      padding: "8px",
                      marginBottom: 4,
                      border: "none",
                      borderRadius: 5,
                      background: selection?.type === type ? "var(--bg-selected)" : "transparent",
                      color: "var(--text)",
                      cursor: "pointer",
                      fontSize: 12,
                    }}
                  >
                    {type === "routing"
                      ? t("modelAutoRouting", "Auto routing")
                      : t("modelAdvancedSettings", "Advanced model settings")}
                  </button>
                ))}
                {/* Active OAuth subscriptions */}
                {activeOAuth.map((p) => {
                  const isSelected = selection?.type === "oauth" && selection.providerId === p.id;
                  return (
                    <div
                      key={p.id}
                      onClick={() => setSelection({ type: "oauth", providerId: p.id })}
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: 7,
                        padding: "5px 8px",
                        borderRadius: 5,
                        cursor: "pointer",
                        background: isSelected ? "var(--bg-selected)" : "none",
                      }}
                      onMouseEnter={(e) => {
                        if (!isSelected) e.currentTarget.style.background = "var(--bg-hover)";
                      }}
                      onMouseLeave={(e) => {
                        if (!isSelected) e.currentTarget.style.background = "none";
                      }}
                    >
                      <ProviderIcon id={p.id} size={16} />
                      <span
                        style={{
                          fontSize: 12,
                          color: "var(--text)",
                          flex: 1,
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          whiteSpace: "nowrap",
                        }}
                      >
                        {oauthProviderName(p.id, p.name, t)}
                      </span>
                    </div>
                  );
                })}

                {/* Active API key providers */}
                {activeApiKey.map((p) => {
                  const isSelected = selection?.type === "apikey" && selection.providerId === p.id;
                  return (
                    <div
                      key={p.id}
                      onClick={() => setSelection({ type: "apikey", providerId: p.id })}
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: 7,
                        padding: "5px 8px",
                        borderRadius: 5,
                        cursor: "pointer",
                        background: isSelected ? "var(--bg-selected)" : "none",
                      }}
                      onMouseEnter={(e) => {
                        if (!isSelected) e.currentTarget.style.background = "var(--bg-hover)";
                      }}
                      onMouseLeave={(e) => {
                        if (!isSelected) e.currentTarget.style.background = "none";
                      }}
                    >
                      <ProviderIcon id={p.id} size={16} />
                      <span
                        style={{
                          fontSize: 12,
                          color: "var(--text)",
                          flex: 1,
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          whiteSpace: "nowrap",
                        }}
                      >
                        {p.displayName}
                      </span>
                    </div>
                  );
                })}

                {/* Divider before custom providers, only when there are active managed providers */}
                {(activeOAuth.length > 0 || activeApiKey.length > 0) && providers.length > 0 && (
                  <div style={{ margin: "4px 8px", borderTop: "1px solid var(--border)" }} />
                )}

                {/* Custom providers */}
                {loading ? (
                  <div style={{ padding: "10px 8px", fontSize: 12, color: "var(--text-muted)" }}>
                    {t("loading", "Loading…")}
                  </div>
                ) : (
                  <CustomProviderTree
                    providers={providers}
                    selection={selection}
                    onSelect={setSelection}
                    onAddModel={addModel}
                  />
                )}
              </div>

              {/* Add provider */}
              <div style={{ borderTop: "1px solid var(--border)", padding: "8px 6px" }}>
                <button
                  ref={addProviderButtonRef}
                  aria-label={t("addProvider", "Add provider")}
                  onClick={() => setPickerOpen(true)}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    gap: 5,
                    width: "100%",
                    padding: "6px 0",
                    background: "none",
                    border: "1px dashed var(--border)",
                    borderRadius: 5,
                    color: "var(--text-muted)",
                    cursor: "pointer",
                    fontSize: 12,
                  }}
                  onMouseEnter={(e) => {
                    e.currentTarget.style.borderColor = "var(--accent)";
                    e.currentTarget.style.color = "var(--accent)";
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.borderColor = "var(--border)";
                    e.currentTarget.style.color = "var(--text-muted)";
                  }}
                >
                  + {t("addProvider", "Add provider")}
                </button>
              </div>
            </div>

            {/* Right: detail */}
            <div style={{ flex: 1, minWidth: 0, overflowY: "auto", padding: 20 }}>
              {loading
                ? null
                : (detailContent ?? (
                    <div
                      style={{
                        height: "100%",
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                        color: "var(--text-dim)",
                        fontSize: 13,
                      }}
                    >
                      {t("selectProviderOrModel", "Select a provider or model")}
                    </div>
                  ))}
            </div>
          </div>

          {/* Footer */}
          {selection?.type !== "routing" && selection?.type !== "advanced" && (
            <div
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "flex-end",
                gap: 10,
                padding: "10px 18px",
                borderTop: "1px solid var(--border)",
                flexShrink: 0,
              }}
            >
              {!saveError &&
                !nameError &&
                configLoaded &&
                (selection?.type === "provider" || selection?.type === "model") && (
                  <span
                    role="status"
                    style={{ fontSize: 11, color: configDirty ? "var(--accent)" : "var(--text-dim)", flex: 1 }}
                  >
                    {configDirty
                      ? t("modelDraftUnsaved", "Connection or model changes are not saved")
                      : t("modelDraftSaved", "Connection and model definitions are saved")}
                  </span>
                )}
              {saveError && <span style={{ fontSize: 12, color: "#f87171", flex: 1 }}>{saveError}</span>}
              {!saveError && nameError && !preparedNames.ok && (
                <span role="alert" style={{ color: "var(--danger)", fontSize: 12, flex: 1 }}>
                  {preparedNames.provider + ": " + nameError}
                </span>
              )}
              {(saveConflict || configIssues.length > 0) && (
                <button
                  type="button"
                  onClick={() => void loadModelsConfig()}
                  disabled={loading || saving}
                  title={t("modelReloadDiskVersionHint", "Discard local edits and load the current models.json")}
                  style={{
                    padding: "6px 12px",
                    background: "none",
                    border: "1px solid var(--border)",
                    borderRadius: 6,
                    color: "var(--text)",
                    cursor: loading || saving ? "default" : "pointer",
                    fontSize: 12,
                  }}
                >
                  {t("modelReloadDiskVersion", "Reload disk version")}
                </button>
              )}
              {!embedded && (
                <button
                  onClick={onClose}
                  style={{
                    padding: "6px 14px",
                    background: "none",
                    border: "1px solid var(--border)",
                    borderRadius: 6,
                    color: "var(--text-muted)",
                    cursor: "pointer",
                    fontSize: 13,
                  }}
                >
                  {t("cancel", "Cancel")}
                </button>
              )}
              <button
                onClick={handleSave}
                disabled={saveDisabled}
                title={
                  nameError ??
                  (loadFailed
                    ? t("modelCannotSaveBeforeLoad", "Cannot save until config loads successfully")
                    : undefined)
                }
                style={{
                  position: "relative",
                  padding: "6px 16px",
                  minWidth: 92,
                  background: savedOk ? "#16a34a" : saveDisabled ? "var(--bg-panel)" : "var(--accent)",
                  border: "none",
                  borderRadius: 6,
                  color: savedOk || !saveDisabled ? "#fff" : "var(--text-muted)",
                  cursor: saveDisabled ? "default" : "pointer",
                  fontSize: 13,
                  fontWeight: 600,
                  display: "inline-flex",
                  alignItems: "center",
                  justifyContent: "center",
                  gap: 6,
                  transition: "background-color 0.2s ease, color 0.2s ease",
                  animation: savedOk ? "saved-pop 0.45s ease" : undefined,
                }}
              >
                {savedOk && (
                  <svg
                    width="14"
                    height="14"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="3"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    style={{ strokeDasharray: 18, animation: "saved-check-draw 0.35s ease forwards", flexShrink: 0 }}
                  >
                    <polyline points="20 6 9 17 4 12" />
                  </svg>
                )}
                <span>{savedOk ? t("saved", "Saved") : saving ? t("saving", "Saving…") : t("save", "Save")}</span>
              </button>
            </div>
          )}
        </div>
      </div>
      {pickerOpen && (
        <AddProviderPicker
          oauthProviders={oauthProviders}
          apiKeyProviders={apiKeyProviders}
          onSelectOAuth={(id) => setSelection({ type: "oauth", providerId: id })}
          onSelectApiKey={(id) => setSelection({ type: "apikey", providerId: id })}
          onAddCustom={addCustomProvider}
          onClose={() => {
            setPickerOpen(false);
            addProviderButtonRef.current?.focus();
          }}
        />
      )}
    </>
  );
}
