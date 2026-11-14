import { useId, useState } from "react";
import { useI18n } from "@/i18n";
import { useSessionListMode } from "@/hooks/useSessionListMode";
import type { SessionListMode } from "@shared/session-list-mode";
import { SettingRow, selectStyle } from "./settings-controls";

/**
 * Sidebar session list mode: independent (one project owns the window) or
 * aggregated (every project's sessions, grouped by project). Persisted through
 * the shared controller so the sidebar updates immediately.
 */
export function SessionListSettings() {
  const { t } = useI18n();
  const controlId = useId();
  const { mode, saving, update } = useSessionListMode();
  const [error, setError] = useState(false);

  const save = async (next: SessionListMode): Promise<void> => {
    setError(false);
    try {
      await update(next);
    } catch {
      setError(true);
    }
  };

  return (
    <section style={{ maxWidth: 620 }}>
      <h2 style={{ margin: 0, fontSize: 14, color: "var(--text)" }}>{t("sessionListMode", "Session list")}</h2>
      <p style={{ margin: "6px 0 16px", fontSize: 12, lineHeight: 1.6, color: "var(--text-dim)" }}>
        {t("sessionListModeDescription", "Choose how the sidebar organizes your sessions.")}
      </p>
      <SettingRow label={t("sessionListModeLabel", "Mode")} controlId={controlId}>
        <select
          id={controlId}
          value={mode}
          disabled={saving}
          onChange={(event) => {
            void save(event.target.value as SessionListMode);
          }}
          style={{ ...selectStyle, cursor: saving ? "wait" : "pointer" }}
        >
          <option value="independent">{t("sessionListModeIndependent", "Independent")}</option>
          <option value="aggregated">{t("sessionListModeAggregated", "Aggregated")}</option>
        </select>
      </SettingRow>
      <p style={{ margin: "10px 0 0", fontSize: 12, lineHeight: 1.55, color: "var(--text-dim)" }}>
        {t(
          "sessionListModeIndependentDesc",
          "Independent: the selected project owns the window context, and its sessions are grouped by date.",
        )}
      </p>
      <p style={{ margin: "6px 0 0", fontSize: 12, lineHeight: 1.55, color: "var(--text-dim)" }}>
        {t(
          "sessionListModeAggregatedDesc",
          "Aggregated: every project's sessions show at once, grouped by project. Clicking a session switches the window to its project.",
        )}
      </p>
      {error && (
        <p role="alert" style={{ margin: "8px 0 0", fontSize: 12, lineHeight: 1.55, color: "var(--danger)" }}>
          {t("sessionListModeSaveFailed", "Session list mode could not be saved. The previous setting was restored.")}
        </p>
      )}
    </section>
  );
}
