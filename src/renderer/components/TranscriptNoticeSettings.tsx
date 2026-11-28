import { useCallback, useEffect, useRef, useState } from "react";
import { noticeKeys, type NoticeKey, type NoticeSettingsStatus } from "@shared/transcript-notices";
import { call, subscribeSessionsChanged } from "@/lib/api-client";
import { useI18n } from "@/i18n";

export function TranscriptNoticeSettings({ cwd, sessionId }: { cwd: string | null; sessionId: string | null }) {
  const { t } = useI18n();
  const [status, setStatus] = useState<NoticeSettingsStatus>();
  const [error, setError] = useState(false);
  const [saving, setSaving] = useState(false);
  const revision = useRef(0);
  const mounted = useRef(false);
  const load = useCallback(async () => {
    const ticket = ++revision.current;
    try {
      const next = await call("settings.notices.get", cwd ? { cwd, sessionId: sessionId ?? undefined } : undefined);
      if (mounted.current && ticket === revision.current) {
        setStatus(next);
        setError(false);
      }
    } catch {
      if (mounted.current && ticket === revision.current) setError(true);
    }
  }, [cwd, sessionId]);
  useEffect(() => {
    mounted.current = true;
    void load();
    let disposed = false,
      unsubscribe: (() => void) | undefined;
    void subscribeSessionsChanged((event) => {
      if (!disposed && (event.fullRefresh || (cwd && event.cwd === cwd && event.projectInfoChanged))) void load();
    })
      .then((off) => {
        if (disposed) off();
        else unsubscribe = off;
      })
      .catch(() => {});
    return () => {
      disposed = true;
      mounted.current = false;
      unsubscribe?.();
    };
  }, [load, cwd]);
  async function save(key: NoticeKey, shown: boolean) {
    const ticket = ++revision.current;
    setSaving(true);
    try {
      const next = await call("settings.notices.set", {
        key,
        shown,
        ...(cwd ? { cwd, sessionId: sessionId ?? undefined } : {}),
      });
      if (mounted.current && ticket === revision.current) {
        setStatus(next);
        setError(false);
      }
    } catch {
      if (mounted.current) setError(true);
    } finally {
      if (mounted.current) setSaving(false);
    }
  }
  const labels = {
    cacheMisses: t("noticesCacheMisses", "Cache misses"),
    cacheWarming: t("noticesCacheWarming", "Cache warming costs"),
    compactionCosts: t("noticesCompactionCosts", "Compaction and branch summary costs"),
    reasoningDrops: t("noticesReasoningDrops", "Dropped reasoning"),
  };
  return (
    <fieldset disabled={saving} style={{ border: "1px solid var(--border)", borderRadius: 6, padding: "8px 12px" }}>
      <legend>{t("noticesTitle", "Global chat notices")}</legend>
      {noticeKeys.map((key) => (
        <label key={key} style={{ display: "flex", alignItems: "center", gap: 8, minHeight: 32 }}>
          <input
            type="checkbox"
            name={`notice-${key}`}
            disabled={!status}
            checked={status?.global[key] ?? false}
            onChange={(event) => void save(key, event.target.checked)}
          />
          {labels[key]}
          {status?.project[key] !== undefined && (
            <small>
              {status.effective[key]
                ? t("noticesProjectOn", "Enabled by this project")
                : t("noticesProjectOff", "Disabled by this project")}
            </small>
          )}
        </label>
      ))}
      {status?.projectLoadFailed && (
        <p role="status">
          {t("noticesProjectReadFailed", "Project overrides could not be read. The switches show global settings.")}
        </p>
      )}
      {error && (
        <p role="alert">
          {t("noticesSettingsError", "Could not read or save the global chat notice settings.")}{" "}
          <button type="button" onClick={() => void load()}>
            {t("retryUpdate", "Retry")}
          </button>
        </p>
      )}
    </fieldset>
  );
}
