import { useEffect, useId, useState } from "react";
import { call } from "@/lib/api-client";
import { useI18n } from "@/i18n";
import type { AgentShell, AgentShellSettings } from "@shared/agent-shell";
import type { PublicToolchainState } from "@shared/toolchains/types";

export function WindowsAgentShellSetting() {
  const [state, setState] = useState<PublicToolchainState | null>(null);
  useEffect(() => {
    if (window.piBridge.platform !== "win32") return;
    let active = true;
    let receivedUpdate = false;
    const unsubscribe = window.piBridge.onToolchainState((next) => {
      receivedUpdate = true;
      if (active) setState(next);
    });
    void window.piBridge.getToolchainState().then(
      (next) => {
        if (active && !receivedUpdate) setState(next);
      },
      () => undefined,
    );
    return () => {
      active = false;
      unsubscribe();
    };
  }, []);
  return state?.platform === "win32" ? <AgentShellSetting state={state} /> : null;
}

export function AgentShellSetting({ state }: { state: PublicToolchainState }) {
  const { t } = useI18n();
  const id = useId();
  const [settings, setSettings] = useState<AgentShellSettings | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<"load" | "save" | null>(null);
  useEffect(() => {
    let active = true;
    void call("settings.getAgentShell").then(
      (value) => {
        if (active) setSettings(value);
      },
      () => {
        if (active) setError("load");
      },
    );
    return () => {
      active = false;
    };
  }, []);
  const save = async (shell: AgentShell) => {
    setSaving(true);
    setError(null);
    try {
      setSettings(await call("settings.setAgentShell", { shell }));
    } catch {
      setError("save");
    } finally {
      setSaving(false);
    }
  };
  return (
    <section
      aria-label={t("agentShell", "Default Agent shell")}
      style={{ maxWidth: 620, paddingBottom: 28, marginBottom: 28, borderBottom: "1px solid var(--border)" }}
    >
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 16 }}>
        <label htmlFor={id} style={{ fontSize: 14, color: "var(--text)" }}>
          {t("agentShell", "Default Agent shell")}
        </label>
        <select
          id={id}
          value={settings?.shell ?? ""}
          disabled={!settings || saving}
          onChange={(event) => void save(event.target.value as AgentShell)}
          style={{
            minWidth: 145,
            minHeight: 34,
            padding: "4px 8px",
            borderRadius: 6,
            border: "1px solid var(--border)",
            color: "var(--text)",
            background: "var(--bg)",
          }}
        >
          {!settings && <option value="">{t("loading", "Loading…")}</option>}
          {(["powershell", "bash"] as const).map((shell) => (
            <option key={shell} value={shell} disabled={state.capabilities[`shell.${shell}`]?.health !== "healthy"}>
              {shell === "powershell" ? "PowerShell" : "Bash"}
            </option>
          ))}
        </select>
      </div>
      <p style={{ margin: "8px 0 0", fontSize: 12, color: "var(--text-dim)", lineHeight: 1.5 }}>
        {t(
          "agentShellHint",
          "Used by new sessions when command execution is allowed. Existing sessions keep their shell.",
        )}
      </p>
      {settings && state.capabilities[`shell.${settings.shell}`]?.health !== "healthy" && (
        <p role="status" style={{ fontSize: 12, color: "var(--text-dim)" }}>
          {t(
            "agentShellUnavailable",
            "The selected shell is unavailable. Configure its executable in Developer tools.",
          )}
        </p>
      )}
      {error && (
        <p role="alert" style={{ fontSize: 12, color: "var(--danger)" }}>
          {error === "load"
            ? t("agentShellLoadFailed", "The default shell could not be loaded.")
            : t("agentShellSaveFailed", "The default shell could not be saved.")}
        </p>
      )}
    </section>
  );
}
