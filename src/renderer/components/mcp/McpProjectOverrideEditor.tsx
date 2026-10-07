import { useEffect, useId, useState } from "react";
import type { McpExposure, McpServerConfig } from "@contract/mcp";
import { useI18n } from "@/i18n";

/** Saves only project policy. Connection details and credentials remain in the global file. */
export function McpProjectOverrideEditor({
  initial,
  busy,
  onDirty,
  onCancel,
  onSave,
}: {
  initial: { name: string; config: McpServerConfig };
  busy: boolean;
  onDirty(): void;
  onCancel(): void;
  onSave(name: string, config: McpServerConfig): void;
}) {
  const { t } = useI18n(),
    id = useId();
  const [config, setConfig] = useState(initial.config),
    [toolExposure, setToolExposure] = useState(""),
    [error, setError] = useState<string>();
  useEffect(() => {
    setConfig(initial.config);
    setToolExposure(
      initial.config.toolExposure === undefined ? "" : JSON.stringify(initial.config.toolExposure, null, 2),
    );
    setError(undefined);
  }, [initial]);
  const change = (key: "enabled" | "exposure", value: boolean | McpExposure | undefined) => {
    setConfig((previous) => {
      const next = { ...previous, [key]: value };
      if (value === undefined) delete next[key];
      return next;
    });
    onDirty();
  };
  const submit = () => {
    try {
      const next = { ...config };
      if (toolExposure.trim()) next.toolExposure = JSON.parse(toolExposure);
      else delete next.toolExposure;
      onSave(initial.name, next);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };
  return (
    <section className="mcp-editor" data-mcp-project-override>
      <h4>
        {t("mcpProjectOverride", "Project override")}: {initial.name}
      </h4>
      <p>
        {t(
          "mcpProjectOverrideHelp",
          "Inherit connection details from Global. Only these project settings are saved; unset fields follow future global changes.",
        )}
      </p>
      <fieldset disabled={busy}>
        <label htmlFor={`${id}-enabled`}>{t("mcpEnabled", "Enabled")}</label>
        <select
          id={`${id}-enabled`}
          value={config.enabled === undefined ? "" : String(config.enabled)}
          onChange={(event) => change("enabled", event.target.value === "" ? undefined : event.target.value === "true")}
        >
          <option value="">{t("mcpInheritGlobal", "Inherit global setting")}</option>
          <option value="true">{t("mcpEnable", "Enable")}</option>
          <option value="false">{t("mcpDisable", "Disable")}</option>
        </select>
        <label htmlFor={`${id}-exposure`}>{t("mcpExposure", "Tool exposure")}</label>
        <select
          id={`${id}-exposure`}
          value={config.exposure ?? ""}
          onChange={(event) => change("exposure", (event.target.value || undefined) as McpExposure | undefined)}
        >
          <option value="">{t("mcpInheritGlobal", "Inherit global setting")}</option>
          {(["direct", "deferred", "codemode", "codemode-deferred", "hidden"] as const).map((mode) => (
            <option key={mode} value={mode}>
              {mode}
            </option>
          ))}
        </select>
        <label htmlFor={`${id}-tools`}>{t("mcpToolOverrides", "Per-tool exposure (JSON)")}</label>
        <textarea
          id={`${id}-tools`}
          value={toolExposure}
          onChange={(event) => {
            setToolExposure(event.target.value);
            onDirty();
          }}
        />
        <p>
          {t(
            "mcpOverrideToolsHelp",
            "Leave empty to inherit global per-tool settings. An object replaces the entire global per-tool map; {} clears it.",
          )}
        </p>
      </fieldset>
      {error && (
        <p role="alert" className="mcp-error">
          {error}
        </p>
      )}
      <div className="mcp-actions mcp-editor-footer">
        <button className="mcp-primary" disabled={busy} onClick={submit}>
          {t("mcpSave", "Save configuration")}
        </button>
        <button disabled={busy} onClick={onCancel}>
          {t("mcpCancel", "Cancel")}
        </button>
      </div>
    </section>
  );
}
