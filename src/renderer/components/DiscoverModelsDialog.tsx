import { useEffect, useMemo, useState } from "react";
import { useI18n } from "@/i18n";
import type { DiscoveredModel } from "@contract/types";

interface DiscoverModelsDialogProps {
  open: boolean;
  providerLabel: string;
  loading: boolean;
  models: DiscoveredModel[];
  /** ids already present in the provider's model list (excluded from selection by default). */
  existingIds: Set<string>;
  error: string | null;
  endpoint: string | null;
  onClose: () => void;
  onInsert: (selected: DiscoveredModel[]) => void;
}

export function DiscoverModelsDialog({
  open,
  providerLabel,
  loading,
  models,
  existingIds,
  error,
  endpoint,
  onClose,
  onInsert,
}: DiscoverModelsDialogProps) {
  const { t } = useI18n();
  const [query, setQuery] = useState("");
  const [checked, setChecked] = useState<Record<string, boolean>>({});

  // Reset selection state whenever the fetched candidate list changes.
  useEffect(() => {
    const next: Record<string, boolean> = {};
    for (const m of models) {
      // Pre-existing ids start unchecked (marked "already exists"); new ids default to checked.
      next[m.id] = existingIds.has(m.id) ? false : true;
    }
    setChecked(next);
  }, [models, existingIds]);

  useEffect(() => {
    if (open) setQuery("");
  }, [open]);

  const normalizedQuery = query.trim().toLocaleLowerCase();
  const visibleModels = useMemo(
    () =>
      normalizedQuery
        ? models.filter(
            (m) =>
              m.id.toLocaleLowerCase().includes(normalizedQuery) ||
              (m.name?.toLocaleLowerCase().includes(normalizedQuery) ?? false),
          )
        : models,
    [models, normalizedQuery],
  );

  const checkedNewIds = models.filter((m) => checked[m.id] && !existingIds.has(m.id));
  const insertCount = checkedNewIds.length;
  const allNewChecked = models.length > 0 && models.every((m) => existingIds.has(m.id) || checked[m.id]);
  const hasNewModels = models.some((m) => !existingIds.has(m.id));

  if (!open) return null;

  const toggleAll = () => {
    const target = !allNewChecked;
    const next: Record<string, boolean> = { ...checked };
    for (const m of models) {
      if (!existingIds.has(m.id)) next[m.id] = target;
    }
    setChecked(next);
  };

  return (
    <div
      onClick={onClose}
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.5)",
        zIndex: 1000,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 16,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: "100%",
          maxWidth: 560,
          maxHeight: "80vh",
          display: "flex",
          flexDirection: "column",
          background: "var(--bg-panel)",
          border: "1px solid var(--border)",
          borderRadius: 8,
          boxShadow: "0 8px 32px rgba(0,0,0,0.4)",
        }}
      >
        <div style={{ padding: "16px 18px", borderBottom: "1px solid var(--border)" }}>
          <div style={{ fontSize: 14, fontWeight: 600, color: "var(--text)" }}>
            {t("discoverModelsTitle", "Discover models")} — {providerLabel}
          </div>
          <div style={{ fontSize: 11, color: "var(--text-dim)", marginTop: 3 }}>
            {endpoint ?? t("discoverFetchingFromEndpoint", "Fetching from the endpoint…")}
          </div>
        </div>

        <div style={{ flex: 1, overflowY: "auto", padding: "10px 18px" }}>
          {loading && (
            <div style={{ fontSize: 12, color: "var(--text-muted)", padding: "20px 0", textAlign: "center" }}>
              {t("loading", "Loading…")}
            </div>
          )}
          {!loading && error && (
            <div style={{ fontSize: 12, color: "#f87171", padding: "12px", background: "var(--danger-soft)", border: "1px solid var(--danger-border)", borderRadius: 6 }}>
              {error}
            </div>
          )}
          {!loading && !error && models.length === 0 && (
            <div style={{ fontSize: 12, color: "var(--text-muted)", padding: "20px 0", textAlign: "center" }}>
              {t("discoverNoModels", "No models found.")}
            </div>
          )}
          {!loading && !error && models.length > 0 && (
            <>
              <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
                <button
                  type="button"
                  onClick={toggleAll}
                  disabled={!hasNewModels}
                  style={{
                    padding: "4px 9px",
                    background: "none",
                    border: "1px solid var(--border)",
                    borderRadius: 5,
                    color: "var(--text-muted)",
                    cursor: !hasNewModels ? "not-allowed" : "pointer",
                    fontSize: 11,
                  }}
                >
                  {allNewChecked ? t("discoverDeselectAll", "Deselect all") : t("discoverSelectAll", "Select all")}
                </button>
                <input
                  type="search"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder={t("modelSearchModels", "Search models…")}
                  style={{
                    flex: 1,
                    padding: "5px 9px",
                    background: "var(--bg)",
                    border: "1px solid var(--border)",
                    borderRadius: 5,
                    color: "var(--text)",
                    fontSize: 12,
                    outline: "none",
                  }}
                />
              </div>
              <div style={{ display: "flex", flexDirection: "column", border: "1px solid var(--border)", borderRadius: 6 }}>
                {visibleModels.map((m, idx) => {
                  const exists = existingIds.has(m.id);
                  const isChecked = !!checked[m.id];
                  const meta: string[] = [];
                  if (m.reasoning) meta.push("reasoning");
                  if (m.contextWindow) meta.push(`${(m.contextWindow / 1000).toFixed(0)}k ctx`);
                  if (m.maxTokens) meta.push(`${(m.maxTokens / 1000).toFixed(0)}k out`);
                  return (
                    <label
                      key={m.id}
                      style={{
                        display: "flex",
                        alignItems: "flex-start",
                        gap: 9,
                        padding: "8px 10px",
                        borderTop: idx > 0 ? "1px solid var(--border)" : undefined,
                        cursor: exists ? "default" : "pointer",
                        opacity: exists ? 0.5 : 1,
                      }}
                    >
                      <input
                        type="checkbox"
                        checked={isChecked}
                        disabled={exists}
                        onChange={(e) => setChecked((prev) => ({ ...prev, [m.id]: e.target.checked }))}
                        style={{ margin: "2px 0 0", accentColor: "var(--accent)", flexShrink: 0 }}
                      />
                      <span style={{ minWidth: 0, flex: 1 }}>
                        <span style={{ display: "block", color: "var(--text)", fontSize: 12, lineHeight: 1.35, overflowWrap: "anywhere" }}>
                          {m.name ?? m.id}
                        </span>
                        {m.name && m.name !== m.id && (
                          <code style={{ display: "block", marginTop: 2, color: "var(--text-dim)", fontSize: 10, fontFamily: "var(--font-mono)", overflowWrap: "anywhere" }}>
                            {m.id}
                          </code>
                        )}
                        {meta.length > 0 && (
                          <span style={{ display: "block", marginTop: 2, color: "var(--text-dim)", fontSize: 10 }}>
                            {meta.join(" · ")}
                          </span>
                        )}
                        {exists && (
                          <span style={{ display: "block", marginTop: 2, color: "var(--text-dim)", fontSize: 10, fontStyle: "italic" }}>
                            {t("discoverExists", "Already in list")}
                          </span>
                        )}
                      </span>
                    </label>
                  );
                })}
                {visibleModels.length === 0 && (
                  <span style={{ padding: "10px", color: "var(--text-muted)", fontSize: 12 }}>
                    {t("modelNoMatchingModels", "No matching models.")}
                  </span>
                )}
              </div>
            </>
          )}
        </div>

        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, padding: "12px 18px", borderTop: "1px solid var(--border)" }}>
          <button
            type="button"
            onClick={onClose}
            style={{
              padding: "6px 14px",
              background: "none",
              border: "1px solid var(--border)",
              borderRadius: 5,
              color: "var(--text-muted)",
              cursor: "pointer",
              fontSize: 12,
            }}
          >
            {t("cancel", "Cancel")}
          </button>
          <button
            type="button"
            onClick={() => onInsert(checkedNewIds)}
            disabled={loading || !!error || insertCount === 0}
            style={{
              padding: "6px 14px",
              background: "var(--accent)",
              border: "none",
              borderRadius: 5,
              color: "#fff",
              cursor: insertCount === 0 ? "not-allowed" : "pointer",
              fontSize: 12,
              fontWeight: 600,
            }}
          >
            {t("discoverInsert", "Insert {count}").replace("{count}", String(insertCount))}
          </button>
        </div>
      </div>
    </div>
  );
}
