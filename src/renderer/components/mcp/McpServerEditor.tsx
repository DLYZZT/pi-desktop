import { useEffect, useId, useState } from "react";
import type { McpServerConfig, McpExposure } from "@contract/mcp";
import { useI18n } from "@/i18n";

export function McpServerEditor({
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
  const [name, setName] = useState(initial.name),
    [config, setConfig] = useState(initial.config),
    [jsonFields, setJsonFields] = useState<Record<string, string>>({}),
    [advanced, setAdvanced] = useState(false),
    [advancedText, setAdvancedText] = useState(""),
    [error, setError] = useState<string>();
  useEffect(() => {
    setName(initial.name);
    setConfig(initial.config);
    setJsonFields({});
    setAdvanced(false);
    setError(undefined);
  }, [initial]);
  const change = (patch: Partial<McpServerConfig>) => {
    setConfig((current) => ({ ...current, ...patch }));
    onDirty();
  };
  const field = (key: "args" | "env" | "headers" | "oauth" | "toolExposure", label: string) => (
    <label>
      {label}
      <textarea
        aria-label={label}
        value={jsonFields[key] ?? JSON.stringify(config[key] ?? (key === "args" ? [] : {}), null, 2)}
        onChange={(event) => {
          setJsonFields((current) => ({ ...current, [key]: event.target.value }));
          onDirty();
        }}
      />
    </label>
  );
  const submit = () => {
    try {
      const value: McpServerConfig = advanced ? JSON.parse(advancedText) : { ...config };
      if (!advanced) for (const [key, raw] of Object.entries(jsonFields)) value[key] = JSON.parse(raw);
      if (!name.trim() || !value || typeof value !== "object" || Array.isArray(value))
        throw new Error(t("mcpInvalidEditor", "Enter a server name and a valid JSON object."));
      onSave(name.trim(), value);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };
  return (
    <section className="mcp-editor">
      <h4>{initial.name ? t("mcpEditServer", "Edit MCP server") : t("mcpAddServer", "Add MCP server")}</h4>
      <fieldset disabled={busy}>
        <label htmlFor={`${id}-name`}>{t("mcpName", "Server name")}</label>
        <input
          id={`${id}-name`}
          value={name}
          readOnly={Boolean(initial.name)}
          onChange={(event) => {
            setName(event.target.value);
            onDirty();
          }}
        />
        <label className="mcp-json-mode">
          {t("mcpAdvanced", "Advanced JSON")}{" "}
          <input
            type="checkbox"
            checked={advanced}
            onChange={(event) => {
              try {
                const value: McpServerConfig = advanced ? JSON.parse(advancedText) : { ...config };
                if (!advanced) for (const [key, raw] of Object.entries(jsonFields)) value[key] = JSON.parse(raw);
                setConfig(value);
                setJsonFields({});
                setAdvanced(event.target.checked);
                setAdvancedText(JSON.stringify(value, null, 2));
                setError(undefined);
              } catch (e) {
                setError(e instanceof Error ? e.message : String(e));
              }
            }}
          />
        </label>
        {advanced ? (
          <label>
            {t("mcpServerJson", "Server configuration JSON")}
            <textarea
              value={advancedText}
              onChange={(event) => {
                setAdvancedText(event.target.value);
                onDirty();
              }}
            />
          </label>
        ) : (
          <>
            <label>
              {t("mcpTransport", "Transport")}{" "}
              <select
                value={config.url !== undefined ? "http" : "stdio"}
                onChange={(event) => {
                  const next = { ...config };
                  if (event.target.value === "http") {
                    delete next.command;
                    delete next.args;
                    delete next.env;
                    next.url = "";
                    next.type = "http";
                  } else {
                    delete next.url;
                    delete next.headers;
                    delete next.oauth;
                    delete next.auth;
                    next.command = "";
                    next.type = "stdio";
                  }
                  setConfig(next);
                  setJsonFields({});
                  onDirty();
                }}
              >
                <option value="stdio">stdio</option>
                <option value="http">Streamable HTTP</option>
              </select>
            </label>
            {config.url !== undefined ? (
              <>
                <label>
                  {t("mcpUrl", "MCP URL")}
                  <input value={config.url} onChange={(event) => change({ url: event.target.value })} />
                </label>
              </>
            ) : (
              <>
                <label>
                  {t("mcpCommand", "Command")}
                  <input value={config.command ?? ""} onChange={(event) => change({ command: event.target.value })} />
                </label>
                {field("args", t("mcpArguments", "Arguments (JSON array)"))}
                <label>
                  {t("mcpWorkingDirectory", "Working directory")}
                  <input
                    value={config.cwd ?? ""}
                    onChange={(event) => change({ cwd: event.target.value || undefined })}
                  />
                </label>
              </>
            )}
            <details className="mcp-advanced-settings">
              <summary>{t("mcpAdvancedSettings", "Advanced settings")}</summary>
              {config.url !== undefined ? (
                <>
                  {field("headers", t("mcpHeaders", "HTTP headers (JSON)"))}
                  {field("oauth", t("mcpOAuthOptions", "OAuth options (JSON)"))}
                </>
              ) : (
                field("env", t("mcpEnvironment", "Environment (JSON)"))
              )}
              <label>
                {t("mcpExposure", "Tool exposure")}{" "}
                <select
                  value={config.exposure ?? "codemode"}
                  onChange={(event) => change({ exposure: event.target.value as McpExposure })}
                >
                  {(["direct", "deferred", "codemode", "codemode-deferred", "hidden"] as const).map((mode) => (
                    <option key={mode} value={mode}>
                      {mode}
                    </option>
                  ))}
                </select>
              </label>
              {field("toolExposure", t("mcpToolOverrides", "Per-tool exposure (JSON)"))}
              <label>
                {t("mcpTimeout", "Request timeout (seconds)")}
                <input
                  type="number"
                  min="1"
                  max="3600"
                  value={config.timeout ?? 60}
                  onChange={(event) => change({ timeout: Number(event.target.value) })}
                />
              </label>
              <label>
                <input
                  type="checkbox"
                  checked={config.enabled !== false}
                  onChange={(event) => change({ enabled: event.target.checked })}
                />
                {t("mcpEnabled", "Enabled")}
              </label>
              <p>
                {t(
                  "mcpSecretHelp",
                  "Saved secrets appear as placeholders. Keep the placeholder to preserve a secret, or enter a new value to replace it.",
                )}
              </p>
            </details>
          </>
        )}
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
