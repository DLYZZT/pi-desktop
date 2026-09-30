import { useEffect, useState } from "react";
import type { McpPanelSnapshot } from "@contract/mcp";
import { call, subscribe } from "@/lib/api-client";
import { useI18n } from "@/i18n";
import { McpToolsPanel } from "./McpToolsPanel";

export function McpSessionMenu({ sessionId }: { sessionId: string }) {
  const { t } = useI18n(),
    [open, setOpen] = useState(false),
    [panel, setPanel] = useState<McpPanelSnapshot>(),
    [error, setError] = useState<string>();
  useEffect(() => {
    let disposed = false,
      off: (() => void) | undefined;
    void subscribe("mcp.settings", sessionId, () =>
      window.dispatchEvent(new CustomEvent("pi-desktop:open-mcp-settings", { detail: { sessionId } })),
    )
      .then((value) => {
        if (disposed) value();
        else off = value;
      })
      .catch(() => undefined);
    return () => {
      disposed = true;
      off?.();
    };
  }, [sessionId]);
  const load = async () => {
    try {
      setPanel(await call("mcp.snapshot", { sessionId }));
      setError(undefined);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };
  return (
    <section className="mcp-config mcp-session-menu">
      <div className="mcp-actions">
        <button
          onClick={() => {
            setOpen((value) => !value);
            if (!open) void load();
          }}
          aria-expanded={open}
        >
          {t("mcpSessionTools", "Session MCP tool permissions")}
        </button>
        <button
          onClick={() =>
            window.dispatchEvent(new CustomEvent("pi-desktop:open-mcp-settings", { detail: { sessionId } }))
          }
        >
          {t("mcpOpenSettings", "Open MCP settings")}
        </button>
      </div>
      {open && (
        <>
          {error && <p role="alert">{error}</p>}
          <McpToolsPanel sessionId={sessionId} panel={panel} onChanged={load} />
        </>
      )}
    </section>
  );
}
