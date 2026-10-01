import type { McpConfigEntry, McpPanelSnapshot } from "@contract/mcp";
import { useI18n } from "@/i18n";
import { mcpStateLabel } from "@/lib/mcp-state-label";

export function McpServerSidebar({
  entries,
  panel,
  selected,
  onSelect,
}: {
  entries: McpConfigEntry[];
  panel?: McpPanelSnapshot;
  selected?: string;
  onSelect(entry: McpConfigEntry): void;
}) {
  const { t } = useI18n();
  return (
    <div className="mcp-server-list" role="list" aria-label={t("mcpSettings", "MCP servers")}>
      {entries.map((entry) => {
        const live = panel?.instances.find((instance) => instance.name === entry.name);
        const state = entry.config.enabled === false ? "disabled" : (live?.state ?? "not-started");
        return (
          <button
            key={`${entry.scope}:${entry.name}`}
            type="button"
            className={`mcp-server-item${selected === entry.name ? " is-selected" : ""}`}
            onClick={() => onSelect(entry)}
            aria-pressed={selected === entry.name}
          >
            <span className={`mcp-status-dot is-${state}`} aria-hidden="true" />
            <span className="mcp-server-item-copy">
              <strong>{entry.name}</strong>
              <span>
                {mcpStateLabel(state, t)} · {entry.config.url ? "HTTP" : "stdio"}
              </span>
            </span>
          </button>
        );
      })}
      {!entries.length && <p className="mcp-list-empty">{t("mcpNoServers", "No MCP servers configured.")}</p>}
    </div>
  );
}
