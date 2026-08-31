import { useCallback, useEffect, useId, useRef, useState } from "react";
import { call, subscribe } from "@/lib/api-client";
import { copyText } from "@/lib/clipboard";
import { useI18n } from "@/i18n";
import { isNewerHerdrSnapshot, type HerdrSnapshotOrder } from "@/hooks/herdr-snapshot-order";
import {
  DEFAULT_HERDR_SETTINGS,
  type HerdrDiagnostics,
  type HerdrRuntimeSnapshot,
  type HerdrSettings as HerdrSettingsValue,
} from "@contract/herdr";
import { herdrErrorLabel, herdrRuntimeStatusLabel, publicHerdrErrorLabel } from "./herdr-ui-copy";

export function HerdrSettings() {
  const { t } = useI18n();
  const [settings, setSettings] = useState<HerdrSettingsValue>(DEFAULT_HERDR_SETTINGS);
  const [savedSettings, setSavedSettings] = useState<HerdrSettingsValue | null>(null);
  const [runtime, setRuntime] = useState<HerdrRuntimeSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [diagnostics, setDiagnostics] = useState<HerdrDiagnostics | null>(null);
  const [diagnosticsLoading, setDiagnosticsLoading] = useState(false);
  const [diagnosticsCopied, setDiagnosticsCopied] = useState(false);
  const runtimeOrderRef = useRef<HerdrSnapshotOrder | null>(null);
  const enabledId = useId();
  const autoConnectId = useId();
  const releaseId = useId();

  const acceptRuntime = useCallback((snapshot: HerdrRuntimeSnapshot) => {
    if (!isNewerHerdrSnapshot(snapshot, runtimeOrderRef.current)) return false;
    runtimeOrderRef.current = snapshot;
    setRuntime(snapshot);
    return true;
  }, []);

  useEffect(() => {
    let disposed = false;
    void Promise.all([window.piBridge.getUiState(), call("herdr.runtime.get")])
      .then(([ui, snapshot]) => {
        if (disposed) return;
        const initialSettings = ui.herdrSettings ?? DEFAULT_HERDR_SETTINGS;
        setSettings(initialSettings);
        setSavedSettings(initialSettings);
        acceptRuntime(snapshot);
        setError(null);
      })
      .catch((nextError) => {
        if (!disposed) setError(herdrErrorLabel(nextError, t));
      })
      .finally(() => {
        if (!disposed) setLoading(false);
      });
    return () => {
      disposed = true;
    };
  }, [acceptRuntime, t]);

  const refreshDiagnostics = useCallback(async () => {
    setDiagnosticsLoading(true);
    try {
      setDiagnostics(await call("herdr.diagnostics"));
    } catch (nextError) {
      setError(herdrErrorLabel(nextError, t));
    } finally {
      setDiagnosticsLoading(false);
    }
  }, [t]);

  useEffect(() => {
    void refreshDiagnostics();
  }, [refreshDiagnostics]);

  const copyDiagnostics = async () => {
    if (!diagnostics) return;
    try {
      await copyText(JSON.stringify(diagnostics, null, 2));
      setDiagnosticsCopied(true);
      window.setTimeout(() => setDiagnosticsCopied(false), 1_400);
    } catch (nextError) {
      setError(herdrErrorLabel(nextError, t));
    }
  };

  useEffect(() => {
    let disposed = false;
    let release: (() => void) | undefined;
    void subscribe("herdr.runtime", "*", (snapshot) => {
      if (!disposed) acceptRuntime(snapshot);
    }).then((nextRelease) => {
      if (disposed) nextRelease();
      else release = nextRelease;
    });
    return () => {
      disposed = true;
      release?.();
    };
  }, [acceptRuntime]);

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      acceptRuntime(await call("herdr.runtime.configure", { settings }));
      setSavedSettings(settings);
    } catch (nextError) {
      setError(herdrErrorLabel(nextError, t));
    } finally {
      setSaving(false);
    }
  };

  const action = async (kind: "probe" | "connect" | "disconnect") => {
    setSaving(true);
    setError(null);
    try {
      if (kind === "probe") acceptRuntime(await call("herdr.runtime.probe"));
      else if (kind === "connect") acceptRuntime(await call("herdr.runtime.connect"));
      else {
        await call("herdr.runtime.disconnect");
        acceptRuntime(await call("herdr.runtime.get"));
      }
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : String(nextError));
    } finally {
      setSaving(false);
    }
  };

  const update = <K extends keyof HerdrSettingsValue>(key: K, value: HerdrSettingsValue[K]) =>
    setSettings((current) => ({ ...current, [key]: value }));
  const dirty = savedSettings !== null && JSON.stringify(settings) !== JSON.stringify(savedSettings);
  const runtimeError = publicHerdrErrorLabel(runtime?.error, t);
  const canDisconnect = Boolean(
    runtime && ["connecting", "ready", "degraded", "reconnecting"].includes(runtime.status),
  );

  return (
    <div style={{ width: "100%", overflowY: "auto", padding: "24px clamp(18px, 4vw, 42px)" }}>
      <div style={{ maxWidth: 680, margin: "0 auto", display: "grid", gap: 22 }}>
        <header>
          <h2 style={pageHeadingStyle}>{t("herdrIntegration", "Herdr integration")}</h2>
          <p style={pageDescriptionStyle}>
            {t(
              "herdrIntegrationDescription",
              "Configure how Pi Desktop connects to a local Herdr Session. Installations and updates are managed in Developer Tools.",
            )}
          </p>
        </header>

        <section style={cardStyle}>
          <label htmlFor={enabledId} style={toggleLabelStyle}>
            <span>
              <strong style={toggleTitleStyle}>{t("enableHerdr", "Enable Herdr")}</strong>
              <small style={toggleDescriptionStyle}>
                {t(
                  "enableHerdrDescription",
                  "Attach leaves a user-started server untouched. Managed starts and stops Pi Desktop's private server automatically.",
                )}
              </small>
            </span>
            <input
              id={enabledId}
              type="checkbox"
              checked={settings.enabled}
              disabled={loading || saving}
              onChange={(event) => update("enabled", event.currentTarget.checked)}
            />
          </label>
        </section>

        <section style={cardStyle}>
          <Field label={t("herdrMode", "Mode")}>
            <select
              style={selectStyle}
              value={settings.mode}
              disabled={loading || saving}
              onChange={(event) => update("mode", event.currentTarget.value as "attach" | "managed")}
            >
              <option value="attach">{t("herdrAttach", "Attach (user-started server)")}</option>
              <option value="managed">{t("herdrManaged", "Managed (automatic server)")}</option>
            </select>
          </Field>
          <Field label={t("herdrSession", "Session name")}>
            <input
              style={inputStyle}
              value={settings.sessionName}
              maxLength={64}
              spellCheck={false}
              disabled={loading || saving}
              onChange={(event) => update("sessionName", event.currentTarget.value)}
            />
          </Field>
          <label htmlFor={autoConnectId} style={toggleLabelStyle}>
            <span>
              <strong style={toggleTitleStyle}>{t("herdrAutoConnect", "Connect automatically")}</strong>
              <small style={toggleDescriptionStyle}>
                {t("herdrAutoConnectDescription", "Reconnect after the Agent Host restarts or the socket returns.")}
              </small>
            </span>
            <input
              id={autoConnectId}
              type="checkbox"
              checked={settings.autoConnect}
              disabled={loading || saving}
              onChange={(event) => update("autoConnect", event.currentTarget.checked)}
            />
          </label>
          <label htmlFor={releaseId} style={toggleLabelStyle}>
            <span>
              <strong style={toggleTitleStyle}>
                {t("herdrReleaseControl", "Release terminal control when the view closes")}
              </strong>
              <small style={toggleDescriptionStyle}>
                {t(
                  "herdrReleaseControlDescription",
                  "Enabled: closing the view releases Pi Desktop's controller. Disabled: the local bridge closes, but Herdr may retain the controller. The pane keeps running.",
                )}
              </small>
            </span>
            <input
              id={releaseId}
              type="checkbox"
              checked={settings.releaseControlOnViewClose}
              disabled={loading || saving}
              onChange={(event) => update("releaseControlOnViewClose", event.currentTarget.checked)}
            />
          </label>
        </section>

        <section style={cardStyle} aria-live="polite">
          <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "center" }}>
            <div>
              <strong style={{ color: "var(--text)", fontSize: 13 }}>
                {t("herdrRuntimeStatus", "Runtime status")}
              </strong>
              <div
                style={{
                  marginTop: 5,
                  color: runtime?.status === "ready" ? "#16a34a" : "var(--text-muted)",
                  fontSize: 12,
                }}
              >
                {herdrRuntimeStatusLabel(runtime?.status, t)}
                {runtime?.version ? ` · v${runtime.version}` : ""}
                {runtime?.protocol ? ` · protocol ${runtime.protocol}` : ""}
                {runtime?.sessionName ? ` · ${runtime.sessionName}` : ""}
              </div>
            </div>
            <span style={{ fontSize: 11, color: "var(--text-dim)" }}>
              {t("herdrAnsiOnly", "ANSI terminal · graphics unsupported")}
            </span>
          </div>
          {(runtimeError || error) && (
            <div role="alert" style={{ marginTop: 12, color: "#dc2626", fontSize: 12, lineHeight: 1.5 }}>
              {error ?? runtimeError}
            </div>
          )}
        </section>

        <section style={cardStyle} aria-label={t("herdrDiagnostics", "Herdr diagnostics")}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
            <div>
              <strong style={toggleTitleStyle}>{t("herdrDiagnostics", "Herdr diagnostics")}</strong>
              <small style={toggleDescriptionStyle}>
                {t(
                  "herdrDiagnosticsDescription",
                  "A redacted preview of runtime, Fleet, terminal stream, and Agent CLI availability. Paths and command output are excluded.",
                )}
              </small>
            </div>
            <div style={{ display: "flex", gap: 8, flexShrink: 0 }}>
              <button
                type="button"
                disabled={diagnosticsLoading}
                onClick={() => void refreshDiagnostics()}
                style={buttonStyle}
              >
                {diagnosticsLoading ? t("loading", "Loading…") : t("refresh", "Refresh")}
              </button>
              <button type="button" disabled={!diagnostics} onClick={() => void copyDiagnostics()} style={buttonStyle}>
                {diagnosticsCopied ? t("copied", "Copied") : t("copyDiagnostics", "Copy diagnostics")}
              </button>
            </div>
          </div>
          {diagnostics && (
            <>
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "repeat(auto-fit, minmax(125px, 1fr))",
                  gap: 8,
                  color: "var(--text-muted)",
                  fontSize: 12,
                }}
              >
                <span>
                  {t("workspaces", "Workspaces")}: {diagnostics.fleet.workspaces}
                </span>
                <span>
                  {t("panes", "Panes")}: {diagnostics.fleet.panes}
                </span>
                <span>
                  {t("terminalStreams", "Terminal streams")}: {diagnostics.terminal.streams}
                </span>
                <span>
                  {t("terminalControllers", "Controllers")}: {diagnostics.terminal.controllers}
                </span>
              </div>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                {diagnostics.agentClis.map((cli) => (
                  <span
                    key={cli.kind}
                    title={cli.errorCode}
                    style={{
                      padding: "3px 7px",
                      border: "1px solid var(--border)",
                      borderRadius: 999,
                      color: cli.available ? "#16a34a" : "var(--text-dim)",
                      fontSize: 11,
                    }}
                  >
                    {cli.kind}: {cli.available ? cli.version || t("available", "available") : t("missing", "missing")}
                  </span>
                ))}
              </div>
              <details>
                <summary style={{ cursor: "pointer", color: "var(--text-muted)", fontSize: 12 }}>
                  {t("diagnosticPreview", "Redacted preview")}
                </summary>
                <pre
                  style={{
                    maxHeight: 260,
                    margin: "10px 0 0",
                    padding: 12,
                    overflow: "auto",
                    borderRadius: 6,
                    background: "var(--bg)",
                    color: "var(--text-muted)",
                    fontFamily: "var(--font-mono)",
                    fontSize: 10,
                    lineHeight: 1.5,
                    whiteSpace: "pre-wrap",
                    overflowWrap: "anywhere",
                  }}
                >
                  {JSON.stringify(diagnostics, null, 2)}
                </pre>
              </details>
            </>
          )}
        </section>

        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <button type="button" disabled={loading || saving} onClick={() => void save()} style={primaryButtonStyle}>
            {saving ? t("saving", "Saving…") : t("saveAndApply", "Save and apply")}
          </button>
          <button
            type="button"
            disabled={loading || saving || dirty}
            onClick={() => void action("probe")}
            style={buttonStyle}
          >
            {t("probe", "Probe")}
          </button>
          <button
            type="button"
            disabled={loading || saving || dirty || !settings.enabled}
            onClick={() => void action("connect")}
            style={buttonStyle}
          >
            {t("connect", "Connect")}
          </button>
          <button
            type="button"
            disabled={loading || saving || !canDisconnect}
            onClick={() => void action("disconnect")}
            style={buttonStyle}
          >
            {t("disconnect", "Disconnect")}
          </button>
        </div>
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label
      style={{
        display: "grid",
        gridTemplateColumns: "minmax(130px, 0.45fr) minmax(180px, 1fr)",
        gap: 14,
        alignItems: "center",
      }}
    >
      <span style={{ fontSize: 13, color: "var(--text-muted)" }}>{label}</span>
      {children}
    </label>
  );
}

const cardStyle: React.CSSProperties = {
  display: "grid",
  gap: 16,
  padding: 18,
  border: "1px solid var(--border)",
  borderRadius: 9,
  background: "var(--bg-panel)",
};

const toggleLabelStyle: React.CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  alignItems: "center",
  gap: 18,
  color: "var(--text)",
  fontSize: 13,
};

const pageHeadingStyle: React.CSSProperties = {
  margin: 0,
  color: "var(--text)",
  fontSize: 14,
};

const pageDescriptionStyle: React.CSSProperties = {
  margin: "6px 0 0",
  color: "var(--text-dim)",
  fontSize: 12,
  lineHeight: 1.6,
};

const toggleTitleStyle: React.CSSProperties = {
  display: "block",
  color: "var(--text-muted)",
  fontSize: 13,
  fontWeight: 500,
};

const toggleDescriptionStyle: React.CSSProperties = {
  display: "block",
  marginTop: 3,
  color: "var(--text-dim)",
  fontSize: 12,
  fontWeight: 400,
  lineHeight: 1.55,
};

const inputStyle: React.CSSProperties = {
  width: "100%",
  minHeight: 36,
  padding: "7px 10px",
  border: "1px solid var(--border)",
  borderRadius: 6,
  background: "var(--bg)",
  color: "var(--text)",
  fontFamily: "inherit",
  fontSize: 13,
};

const selectStyle: React.CSSProperties = {
  ...inputStyle,
  padding: "7px 30px 7px 10px",
  cursor: "pointer",
};

const buttonStyle: React.CSSProperties = {
  minHeight: 34,
  padding: "0 14px",
  border: "1px solid var(--border)",
  borderRadius: 7,
  background: "var(--bg-panel)",
  color: "var(--text)",
  cursor: "pointer",
  fontFamily: "inherit",
  fontSize: 12,
};

const primaryButtonStyle: React.CSSProperties = {
  ...buttonStyle,
  background: "var(--accent)",
  color: "white",
  borderColor: "var(--accent)",
};
