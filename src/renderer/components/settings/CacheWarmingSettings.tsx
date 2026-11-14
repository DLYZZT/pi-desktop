import { useEffect, useId, useState } from "react";
import { useI18n } from "@/i18n";
import { getCacheWarmingStatus, setCacheWarmingMode } from "@/lib/api-client";
import { SettingRow, selectStyle } from "./settings-controls";

type CacheWarmingMode = "off" | "streaming" | "idle";

/**
 * Prompt cache warming control. The mode lives in the Pi CLI settings file, so
 * this row owns its own load/save cycle instead of the renderer UI state.
 */
export function CacheWarmingSettings() {
  const { t } = useI18n();
  const controlId = useId();
  const [mode, setMode] = useState<CacheWarmingMode>("streaming");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<"load" | "save" | "partial" | null>(null);

  useEffect(() => {
    let disposed = false;
    void getCacheWarmingStatus()
      .then((status) => {
        if (disposed) return;
        setMode(status.mode);
        setError(status.loadFailed ? "load" : null);
      })
      .catch(() => {
        if (!disposed) setError("load");
      })
      .finally(() => {
        if (!disposed) setLoading(false);
      });
    return () => {
      disposed = true;
    };
  }, []);

  const save = async (next: CacheWarmingMode): Promise<void> => {
    const previous = mode;
    setSaving(true);
    setError(null);
    try {
      const result = await setCacheWarmingMode(next);
      setMode(result.mode);
      setError(result.pendingSessionCount > 0 ? "partial" : null);
    } catch {
      try {
        const status = await getCacheWarmingStatus();
        setMode(status.mode);
        setError(status.loadFailed ? "load" : "save");
      } catch {
        setMode(previous);
        setError("save");
      }
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <SettingRow label={t("cacheWarming", "Prompt cache warming")} controlId={controlId}>
        <select
          id={controlId}
          value={mode}
          disabled={loading || saving || error === "load"}
          onChange={(event) => {
            void save(event.target.value as CacheWarmingMode);
          }}
          style={{ ...selectStyle, cursor: saving ? "wait" : "pointer" }}
        >
          <option value="off">{t("cacheWarmingOff", "Off")}</option>
          <option value="streaming">{t("cacheWarmingStreaming", "During long tool runs")}</option>
          <option value="idle">{t("cacheWarmingIdle", "Also while idle")}</option>
        </select>
      </SettingRow>
      <p style={{ margin: 0, fontSize: 12, lineHeight: 1.55, color: "var(--text-dim)" }}>
        {t("cacheWarmingDescription", "Cache warming may use model tokens. This setting is shared with the Pi CLI.")}
      </p>
      {error && (
        <p role="alert" style={{ margin: 0, fontSize: 12, lineHeight: 1.55, color: "var(--danger)" }}>
          {error === "load"
            ? t("cacheWarmingLoadFailed", "The Pi cache warming setting could not be read.")
            : error === "partial"
              ? t("cacheWarmingPartial", "Saved, but some active sessions could not update. Reopen those sessions.")
              : t("cacheWarmingSaveFailed", "The Pi cache warming setting could not be saved.")}
        </p>
      )}
    </>
  );
}
