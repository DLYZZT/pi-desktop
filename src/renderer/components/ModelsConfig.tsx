import { useState, useEffect, useCallback, useReducer } from "react";
import { useIsMobile } from "@/hooks/useIsMobile";
import { useI18n } from "@/i18n";
import {
  addModelTransition,
  deleteProviderTransition,
  modelsConfigEditorReducer,
  renameProviderEntry,
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
} from "@contract/types";
import { ProviderDetail, ModelDetail } from "./models/ModelForms";
import { ProviderIcon } from "./models/ProviderIcon";
import { OAuthDetail } from "./models/OAuthDetail";
import { ApiKeyDetail } from "./models/ApiKeyDetail";
import { AddProviderPicker } from "./models/AddProviderPicker";

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
  const [{ config, selection }, dispatchEditor] = useReducer(modelsConfigEditorReducer, {
    config: { providers: {} },
    selection: null,
  });
  const setConfig = useCallback((update: ModelsConfigUpdate) => dispatchEditor({ type: "config.update", update }), []);
  const setSelection = useCallback(
    (nextSelection: Selection | null) => dispatchEditor({ type: "selection.set", selection: nextSelection }),
    [],
  );
  const [configVersion, setConfigVersion] = useState<string | null>(null);
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
    void loadModelPreferences();
    onChanged?.();
  }, [loadModelPreferences, loadOAuthProviders, onChanged]);

  const refreshApiKeyProviders = useCallback(() => {
    loadApiKeyProviders();
    void loadModelPreferences();
    onChanged?.();
  }, [loadApiKeyProviders, loadModelPreferences, onChanged]);

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
      dispatchEditor({
        type: "config.replace",
        config: normalized,
        selection: keys.length > 0 ? { type: "provider", name: keys[0] } : null,
      });
      setConfigVersion(snapshot.version);
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
    dispatchEditor({ type: "provider.addCustom" });
  }, []);

  const updateProvider = useCallback(
    (name: string, p: ProviderEntry) => {
      setConfig((prev) => ({ ...prev, providers: { ...(prev.providers ?? {}), [name]: p } }));
    },
    [setConfig],
  );

  const renameProvider = useCallback(
    (oldName: string, newName: string) => {
      const result = renameProviderEntry(config, oldName, newName);
      if (!result.ok) {
        setSaveError(result.error);
        return;
      }
      setSaveError(null);
      setConfig(result.config);
      setSelection(selectionAfterProviderRename(selection, oldName, result.name));
    },
    [config, selection, setConfig, setSelection],
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

  const handleSave = useCallback(async () => {
    if (!configVersion) return;
    setSaving(true);
    setSaveError(null);
    setSavedOk(false);
    try {
      const result = await call("modelsConfig.set", { config, expectedVersion: configVersion });
      if (typeof result.version !== "string") {
        setSaveError("Invalid models config save response");
      } else {
        setConfigVersion(result.version);
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
  }, [config, configVersion, loadModelPreferences, onChanged, t]);

  const providers = Object.entries(config.providers ?? {});
  const activeOAuth = oauthProviders.filter((p) => p.loggedIn);
  const activeApiKey = apiKeyProviders.filter((p) => p.configured);

  // Resolve current detail
  const detailContent = (() => {
    if (!selection) return null;
    if (selection.type === "oauth") {
      const p = oauthProviders.find((p) => p.id === selection.providerId);
      if (!p) return null;
      return (
        <OAuthDetail
          key={p.id}
          provider={p}
          onRefresh={refreshOAuthProviders}
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
    if (selection.type === "apikey") {
      const p = apiKeyProviders.find((p) => p.id === selection.providerId);
      if (!p) return null;
      return (
        <ApiKeyDetail
          key={p.id}
          provider={p}
          baseUrl={config.providers?.[p.id]?.baseUrl ?? ""}
          onBaseUrlChange={(baseUrl) => setConfig((prev) => setProviderBaseUrl(prev, p.id, baseUrl))}
          onRefresh={refreshApiKeyProviders}
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
    if (selection.type === "provider") {
      const provider = config.providers?.[selection.name];
      if (!provider) return null;
      return (
        <ProviderDetail
          key={selection.name}
          name={selection.name}
          provider={provider}
          onChange={(p) => updateProvider(selection.name, p)}
          onRename={(n) => renameProvider(selection.name, n)}
          onDelete={() => deleteProvider(selection.name)}
        />
      );
    }
    const provider = config.providers?.[selection.providerName];
    const model = provider?.models?.[selection.index];
    if (!model) return null;
    return (
      <ModelDetail
        key={`${selection.providerName}-${selection.index}`}
        providerName={selection.providerName}
        provider={provider}
        model={model}
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
                        {p.name}
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
                  providers.map(([pName, pData]) => {
                    const isProviderSelected = selection?.type === "provider" && selection.name === pName;
                    const models = pData.models ?? [];
                    return (
                      <div key={pName} style={{ marginBottom: 2 }}>
                        {/* Provider row */}
                        <div
                          onClick={() => setSelection({ type: "provider", name: pName })}
                          style={{
                            display: "flex",
                            alignItems: "center",
                            gap: 6,
                            padding: "7px 8px",
                            borderRadius: 5,
                            cursor: "pointer",
                            background: isProviderSelected ? "var(--bg-selected)" : "none",
                          }}
                          onMouseEnter={(e) => {
                            if (!isProviderSelected) e.currentTarget.style.background = "var(--bg-hover)";
                          }}
                          onMouseLeave={(e) => {
                            if (!isProviderSelected) e.currentTarget.style.background = "none";
                          }}
                        >
                          <svg
                            width="11"
                            height="11"
                            viewBox="0 0 24 24"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="2"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            style={{ color: "var(--text-dim)", flexShrink: 0 }}
                          >
                            <rect x="4" y="4" width="16" height="16" rx="2" />
                            <rect x="9" y="9" width="6" height="6" />
                            <line x1="9" y1="1" x2="9" y2="4" />
                            <line x1="15" y1="1" x2="15" y2="4" />
                            <line x1="9" y1="20" x2="9" y2="23" />
                            <line x1="15" y1="20" x2="15" y2="23" />
                            <line x1="20" y1="9" x2="23" y2="9" />
                            <line x1="20" y1="14" x2="23" y2="14" />
                            <line x1="1" y1="9" x2="4" y2="9" />
                            <line x1="1" y1="14" x2="4" y2="14" />
                          </svg>
                          <span
                            style={{
                              fontSize: 12,
                              fontWeight: isProviderSelected ? 600 : 400,
                              color: "var(--text)",
                              fontFamily: "var(--font-mono)",
                              flex: 1,
                              overflow: "hidden",
                              textOverflow: "ellipsis",
                              whiteSpace: "nowrap",
                            }}
                          >
                            {pName}
                          </span>
                        </div>

                        {/* Model rows */}
                        {models.map((m, i) => {
                          const isModelSelected =
                            selection?.type === "model" && selection.providerName === pName && selection.index === i;
                          return (
                            <div
                              key={i}
                              onClick={() => setSelection({ type: "model", providerName: pName, index: i })}
                              style={{
                                display: "flex",
                                alignItems: "center",
                                gap: 6,
                                padding: "5px 8px 5px 26px",
                                borderRadius: 5,
                                cursor: "pointer",
                                background: isModelSelected ? "var(--bg-selected)" : "none",
                              }}
                              onMouseEnter={(e) => {
                                if (!isModelSelected) e.currentTarget.style.background = "var(--bg-hover)";
                              }}
                              onMouseLeave={(e) => {
                                if (!isModelSelected) e.currentTarget.style.background = "none";
                              }}
                            >
                              <span
                                style={{
                                  fontSize: 11,
                                  fontFamily: "var(--font-mono)",
                                  color: m.id ? "var(--text-muted)" : "var(--text-dim)",
                                  flex: 1,
                                  overflow: "hidden",
                                  textOverflow: "ellipsis",
                                  whiteSpace: "nowrap",
                                }}
                              >
                                {m.id || t("modelNewModel", "new model")}
                              </span>
                              {m.reasoning && (
                                <span
                                  style={{
                                    fontSize: 9,
                                    padding: "1px 4px",
                                    background: "rgba(99,102,241,0.12)",
                                    color: "rgba(99,102,241,0.8)",
                                    borderRadius: 3,
                                    flexShrink: 0,
                                  }}
                                >
                                  T
                                </span>
                              )}
                            </div>
                          );
                        })}

                        {/* Add model button */}
                        <div
                          onClick={(e) => {
                            e.stopPropagation();
                            addModel(pName);
                          }}
                          style={{
                            display: "flex",
                            alignItems: "center",
                            gap: 4,
                            padding: "4px 8px 4px 26px",
                            borderRadius: 5,
                            cursor: "pointer",
                            color: "var(--text-dim)",
                          }}
                          onMouseEnter={(e) => {
                            e.currentTarget.style.color = "var(--accent)";
                            e.currentTarget.style.background = "var(--bg-hover)";
                          }}
                          onMouseLeave={(e) => {
                            e.currentTarget.style.color = "var(--text-dim)";
                            e.currentTarget.style.background = "none";
                          }}
                        >
                          <span style={{ fontSize: 11 }}>+ {t("modelAddModel", "model")}</span>
                        </div>
                      </div>
                    );
                  })
                )}
              </div>

              {/* Add provider */}
              <div style={{ borderTop: "1px solid var(--border)", padding: "8px 6px" }}>
                <button
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
            <div style={{ flex: 1, overflowY: "auto", padding: 20 }}>
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
            {saveError && <span style={{ fontSize: 12, color: "#f87171", flex: 1 }}>{saveError}</span>}
            {saveConflict && (
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
              disabled={saving || savedOk || loading || loadFailed || saveConflict || !configLoaded || !configVersion}
              title={
                loadFailed ? t("modelCannotSaveBeforeLoad", "Cannot save until config loads successfully") : undefined
              }
              style={{
                position: "relative",
                padding: "6px 16px",
                minWidth: 92,
                background: savedOk
                  ? "#16a34a"
                  : saving || loadFailed || saveConflict || !configLoaded || !configVersion
                    ? "var(--bg-panel)"
                    : "var(--accent)",
                border: "none",
                borderRadius: 6,
                color:
                  savedOk || !(saving || loadFailed || saveConflict || !configLoaded || !configVersion)
                    ? "#fff"
                    : "var(--text-muted)",
                cursor:
                  saving || savedOk || loading || loadFailed || saveConflict || !configLoaded || !configVersion
                    ? "default"
                    : "pointer",
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
        </div>
      </div>
      {pickerOpen && (
        <AddProviderPicker
          oauthProviders={oauthProviders}
          apiKeyProviders={apiKeyProviders}
          onSelectOAuth={(id) => setSelection({ type: "oauth", providerId: id })}
          onSelectApiKey={(id) => setSelection({ type: "apikey", providerId: id })}
          onAddCustom={addCustomProvider}
          onClose={() => setPickerOpen(false)}
        />
      )}
    </>
  );
}
