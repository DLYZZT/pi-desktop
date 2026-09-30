import { useState } from "react";
import type { McpPanelSnapshot } from "@contract/mcp";
import { call } from "@/lib/api-client";
import { useI18n } from "@/i18n";

export function McpToolsPanel({
  sessionId,
  panel,
  onChanged,
}: {
  sessionId: string;
  panel?: McpPanelSnapshot;
  onChanged(): void | Promise<void>;
}) {
  const { t } = useI18n(),
    [busy, setBusy] = useState(false),
    [error, setError] = useState<string>();
  const toggle = async (name: string, enabled: boolean) => {
    setBusy(true);
    setError(undefined);
    try {
      const names = new Set((panel?.tools ?? []).filter((tool) => tool.executionAllowed).map((tool) => tool.name));
      if (enabled) names.add(name);
      else names.delete(name);
      if (names.size) for (const entry of panel?.entryTools ?? []) names.add(entry);
      await call("mcp.grants", { sessionId, toolNames: [...names] });
      await onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  const servers = [...new Set(panel?.tools.map((tool) => tool.server) ?? [])];
  return (
    <section className="mcp-tools">
      <h4>{t("mcpSessionTools", "Session MCP tool permissions")}</h4>
      <p>
        {t(
          "mcpPermissionHelp",
          "Declaration, nested lookup and execution permission are separate. Turning a tool off blocks future direct and nested calls.",
        )}
      </p>
      <details>
        <summary>{t("mcpEntryPoints", "Model entry points")}</summary>
        {panel?.entryTools?.map((name) => (
          <label key={name}>
            <input
              type="checkbox"
              checked={panel.declaredEntries?.includes(name) ?? false}
              disabled={busy || panel.emptyTools}
              onChange={(event) => {
                const declarations = new Set([
                  ...(panel.declaredEntries ?? []),
                  ...panel.tools.filter((tool) => tool.active).map((tool) => tool.name),
                ]);
                if (event.target.checked) declarations.add(name);
                else declarations.delete(name);
                setBusy(true);
                void call("mcp.declarations", { sessionId, toolNames: [...declarations] })
                  .then(onChanged)
                  .catch((e) => setError(e instanceof Error ? e.message : String(e)))
                  .finally(() => setBusy(false));
              }}
            />
            {name}
          </label>
        ))}
      </details>
      {error && (
        <p role="alert" className="mcp-error">
          {error}
        </p>
      )}
      {servers.map((server) => (
        <details key={server}>
          <summary>{server}</summary>
          {panel?.tools
            .filter((tool) => tool.server === server)
            .map((tool) => (
              <div key={tool.name} className="mcp-tool-row">
                <label>
                  <input
                    type="checkbox"
                    checked={tool.executionAllowed}
                    disabled={busy || !tool.callable || panel?.emptyTools}
                    onChange={(event) => void toggle(tool.name, event.target.checked)}
                  />
                  {tool.originalName}
                </label>
                <span>
                  {tool.exposure} · {tool.active ? t("mcpDeclared", "Declared") : t("mcpNotDeclared", "Not declared")} ·{" "}
                  {tool.callable ? t("mcpCallable", "Available for lookup") : t("mcpNotCallable", "Unavailable")}
                </span>
                <details>
                  <summary>{t("mcpToolDetails", "Tool schema and hints")}</summary>
                  <p>{tool.description}</p>
                  <pre>{JSON.stringify({ parameters: tool.inputSchema, annotations: tool.annotations }, null, 2)}</pre>
                </details>
              </div>
            ))}
        </details>
      ))}
      {!servers.length && <p>{t("mcpNoTools", "No connected MCP tools in this session.")}</p>}
      {panel?.emptyTools && <p>{t("mcpEmptyTools", "Enable a session tool preset to grant MCP tools.")}</p>}
    </section>
  );
}
