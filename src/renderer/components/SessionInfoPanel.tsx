import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { useI18n } from "@/i18n";
import { copyText } from "@/lib/clipboard";
import { formatCompactNumber } from "@/lib/locale-format";
import type { SessionPresentationStore } from "@/lib/session-presentation-store";
import { LatestRequestGate } from "@/lib/latest-request-gate";

type SessionCopyField = "file" | "id";
type SessionCopyFeedback = { field: SessionCopyField; status: "copied" | "error" };

export function SessionInfoPanel({
  store,
  showChat,
  activeTopPanel,
  toggleTopPanel,
  rightPanelOpen,
  isMobile,
}: {
  store: SessionPresentationStore;
  showChat: boolean;
  activeTopPanel: "session" | null;
  toggleTopPanel: () => void;
  rightPanelOpen: boolean;
  isMobile: boolean;
}) {
  const { t, language } = useI18n();
  const presentation = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  const sessionStats = presentation?.stats ?? null;
  const contextUsage = presentation?.contextUsage ?? null;
  const activeRef = useRef(true);
  const copyRequestGate = useRef(new LatestRequestGate()).current;
  const [sessionCopyFeedback, setSessionCopyFeedback] = useState<SessionCopyFeedback | null>(null);
  const sessionCopyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const handleCopySessionField = useCallback(
    (field: SessionCopyField, value: string) => {
      const request = copyRequestGate.begin();
      const sessionId = store.getSnapshot()?.sessionId;
      const isCurrent = () =>
        activeRef.current && copyRequestGate.isCurrent(request) && sessionId === store.getSnapshot()?.sessionId;
      if (sessionCopyTimerRef.current) clearTimeout(sessionCopyTimerRef.current);
      setSessionCopyFeedback(null);
      void copyText(value)
        .then(() => {
          if (!isCurrent()) return;
          setSessionCopyFeedback({ field, status: "copied" });
          sessionCopyTimerRef.current = setTimeout(() => setSessionCopyFeedback(null), 1_400);
        })
        .catch(() => {
          if (!isCurrent()) return;
          setSessionCopyFeedback({ field, status: "error" });
          sessionCopyTimerRef.current = setTimeout(() => setSessionCopyFeedback(null), 3_000);
        });
    },
    [copyRequestGate, store],
  );

  useEffect(() => {
    copyRequestGate.invalidate();
    setSessionCopyFeedback(null);
    if (sessionCopyTimerRef.current) clearTimeout(sessionCopyTimerRef.current);
  }, [copyRequestGate, presentation?.sessionId]);

  useEffect(() => {
    activeRef.current = true;
    return () => {
      activeRef.current = false;
      if (sessionCopyTimerRef.current) clearTimeout(sessionCopyTimerRef.current);
    };
  }, []);

  return (
    <>
      {/* Session stats — right-aligned in top bar */}
      {showChat &&
        (sessionStats || contextUsage) &&
        (() => {
          const tokenStats = sessionStats?.tokens;
          const c = sessionStats?.cost ?? 0;
          const fmt = (n: number) =>
            n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${(n / 1000).toFixed(0)}k` : String(n);
          let ctxColor = "var(--text-muted)";
          let ctxStr: string | null = null;
          if (contextUsage?.contextWindow) {
            const pct = contextUsage.percent;
            if (pct !== null && pct > 90) ctxColor = "#ef4444";
            else if (pct !== null && pct > 70) ctxColor = "rgba(234,179,8,0.95)";
            ctxStr =
              pct !== null
                ? `${pct.toFixed(0)}% / ${fmt(contextUsage.contextWindow)}`
                : `? / ${fmt(contextUsage.contextWindow)}`;
          }

          const tooltipParts: string[] = [];
          if (tokenStats) {
            tooltipParts.push(`${t("usageInput", "Input")}: ${tokenStats.input.toLocaleString(language)}`);
            tooltipParts.push(`${t("usageOutput", "Output")}: ${tokenStats.output.toLocaleString(language)}`);
            tooltipParts.push(`${t("cacheRead", "Cache read")}: ${tokenStats.cacheRead.toLocaleString(language)}`);
            tooltipParts.push(`${t("cacheWrite", "Cache write")}: ${tokenStats.cacheWrite.toLocaleString(language)}`);
            if (c > 0) tooltipParts.push(`${t("usageCost", "Cost")}: $${c.toFixed(4)}`);
          }
          if (contextUsage?.contextWindow) {
            const pct = contextUsage.percent;
            tooltipParts.push(
              `${t("usageContext", "Context")}: ${pct !== null ? pct.toFixed(1) + "%" : t("unknown", "unknown")} / ${contextUsage.contextWindow.toLocaleString(language)} ${t("tokens", "tokens")}`,
            );
          }
          const tooltip = tooltipParts.join("  |  ");

          return (
            <button
              type="button"
              onClick={toggleTopPanel}
              title={tooltip || t("sessionInfo", "Session info")}
              aria-label={t("sessionInfo", "Session info")}
              aria-pressed={activeTopPanel === "session"}
              style={{
                marginLeft: "auto",
                display: "flex",
                alignItems: "center",
                gap: 8,
                paddingLeft: 12,
                paddingRight: rightPanelOpen ? 12 : 48,
                height: "100%",
                background: activeTopPanel === "session" ? "var(--bg-selected)" : "none",
                border: "none",
                borderTop: activeTopPanel === "session" ? "2px solid var(--accent)" : "2px solid transparent",
                fontSize: 12,
                color: "var(--text-muted)",
                whiteSpace: "nowrap",
                cursor: "pointer",
                fontVariantNumeric: "tabular-nums",
                transition: "color 0.1s, background 0.1s",
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.color = "var(--text)";
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.color = activeTopPanel === "session" ? "var(--text)" : "var(--text-muted)";
              }}
            >
              <svg
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <circle cx="12" cy="12" r="10" />
                <line x1="12" y1="16" x2="12" y2="12" />
                <line x1="12" y1="8" x2="12.01" y2="8" />
              </svg>
              {!isMobile && tokenStats && tokenStats.total > 0 && (
                <span style={{ display: "flex", alignItems: "center", gap: 4 }}>
                  {fmt(tokenStats.total)} {t("tokens", "tokens")}
                </span>
              )}
              {ctxStr && (
                <span style={{ display: "flex", alignItems: "center", gap: 4, color: ctxColor }}>
                  <svg
                    width="12"
                    height="12"
                    viewBox="0 0 10 10"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    aria-hidden="true"
                  >
                    <path d="M1 9 L1 5 Q1 1 5 1 Q9 1 9 5 L9 9" />
                    <line x1="1" y1="9" x2="9" y2="9" />
                  </svg>
                  {ctxStr}
                </span>
              )}
            </button>
          );
        })()}
      {/* Top panel dropdown — shared, only one active at a time */}
      {activeTopPanel && (
        <div
          style={{
            position: "absolute",
            top: "100%",
            left: 0,
            right: 0,
            maxHeight: "calc(100dvh - 44px)",
            overflowY: "auto",
            zIndex: 50,
          }}
        >
          {activeTopPanel === "session" && (
            <div
              className="session-info-popover"
              style={{
                background: "var(--bg-panel)",
                borderBottom: "1px solid var(--border)",
                boxShadow: "0 10px 28px rgba(0,0,0,0.10)",
                padding: "12px 16px",
              }}
            >
              {sessionStats ? (
                (() => {
                  const sessionRows = [
                    ...(sessionStats.sessionName
                      ? [{ label: t("sessionName", "Name"), value: sessionStats.sessionName, copyField: null }]
                      : []),
                    {
                      label: t("sessionFile", "File"),
                      value: sessionStats.sessionFile ?? t("inMemory", "In-memory"),
                      copyField: "file" as const,
                    },
                    { label: t("sessionId", "ID"), value: sessionStats.sessionId, copyField: "id" as const },
                  ];
                  const messageRows = [
                    [t("user", "User"), sessionStats.userMessages.toLocaleString(language)],
                    [t("assistant", "Assistant"), sessionStats.assistantMessages.toLocaleString(language)],
                    [t("toolCalls", "Tool Calls"), sessionStats.toolCalls.toLocaleString(language)],
                    [t("toolResults", "Tool Results"), sessionStats.toolResults.toLocaleString(language)],
                    [t("total", "Total"), sessionStats.totalMessages.toLocaleString(language)],
                  ];
                  const tokenRows = [
                    [t("usageInput", "Input"), sessionStats.tokens.input.toLocaleString(language)],
                    [t("usageOutput", "Output"), sessionStats.tokens.output.toLocaleString(language)],
                    ...(sessionStats.tokens.cacheRead > 0
                      ? [[t("cacheRead", "Cache read"), sessionStats.tokens.cacheRead.toLocaleString(language)]]
                      : []),
                    ...(sessionStats.tokens.cacheWrite > 0
                      ? [[t("cacheWrite", "Cache write"), sessionStats.tokens.cacheWrite.toLocaleString(language)]]
                      : []),
                    [t("total", "Total"), sessionStats.tokens.total.toLocaleString(language)],
                  ];
                  const ctx = contextUsage ?? sessionStats.contextUsage;
                  const extraTokenRows = [
                    ...(sessionStats.cost > 0 ? [[t("usageCost", "Cost"), `$${sessionStats.cost.toFixed(4)}`]] : []),
                    ...(ctx?.contextWindow
                      ? [
                          [
                            t("usageContext", "Context"),
                            `${ctx.percent !== null ? `${ctx.percent.toFixed(1)}%` : "?"} / ${formatCompactNumber(ctx.contextWindow, language)}`,
                          ],
                        ]
                      : []),
                  ];
                  const section = (
                    title: string,
                    sectionRows: string[][],
                    valueAlign: "left" | "right" = "left",
                    compact = false,
                  ) => (
                    <div style={{ minWidth: 0 }}>
                      <div style={{ fontSize: 12, fontWeight: 700, color: "var(--text)", marginBottom: 6 }}>
                        {title}
                      </div>
                      <div
                        style={{
                          display: "grid",
                          gridTemplateColumns: compact ? "max-content max-content" : "auto minmax(0, 1fr)",
                          columnGap: compact ? 14 : 12,
                          rowGap: 4,
                          justifyContent: compact ? "start" : undefined,
                        }}
                      >
                        {sectionRows.map(([label, value]) => (
                          <div key={`${title}:${label}`} style={{ display: "contents" }}>
                            <div style={{ color: "var(--text-dim)", whiteSpace: "nowrap" }}>{label}</div>
                            <div
                              style={{
                                color: "var(--text-muted)",
                                minWidth: 0,
                                overflowWrap: compact ? "normal" : "anywhere",
                                textAlign: valueAlign,
                                whiteSpace: valueAlign === "right" ? "nowrap" : "normal",
                              }}
                            >
                              {value}
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  );
                  const copyButton = (field: SessionCopyField, value: string) => {
                    const feedback = sessionCopyFeedback?.field === field ? sessionCopyFeedback.status : null;
                    const copied = feedback === "copied";
                    const failed = feedback === "error";
                    const defaultLabel =
                      field === "file" ? t("copyFilePath", "Copy file path") : t("copySessionId", "Copy session ID");
                    const label = copied
                      ? t("copied", "Copied")
                      : failed
                        ? t("copyFailed", "Copy failed")
                        : defaultLabel;
                    return (
                      <button
                        type="button"
                        title={label}
                        aria-label={label}
                        onClick={() => handleCopySessionField(field, value)}
                        style={{
                          alignSelf: "start",
                          display: "inline-flex",
                          alignItems: "center",
                          justifyContent: "center",
                          width: 22,
                          height: 22,
                          marginTop: -2,
                          color: failed ? "var(--error, #ef4444)" : copied ? "var(--accent)" : "var(--text-dim)",
                          background: "transparent",
                          border: "1px solid var(--border)",
                          borderRadius: 4,
                          cursor: "pointer",
                          flex: "0 0 auto",
                          transition: "color 0.12s, border-color 0.12s, background 0.12s",
                        }}
                        onMouseEnter={(e) => {
                          e.currentTarget.style.color = "var(--accent)";
                          e.currentTarget.style.borderColor = "var(--accent)";
                          e.currentTarget.style.background = "var(--bg-hover)";
                        }}
                        onMouseLeave={(e) => {
                          e.currentTarget.style.color = failed
                            ? "var(--error, #ef4444)"
                            : copied
                              ? "var(--accent)"
                              : "var(--text-dim)";
                          e.currentTarget.style.borderColor = "var(--border)";
                          e.currentTarget.style.background = "transparent";
                        }}
                      >
                        {failed ? (
                          <svg
                            width="12"
                            height="12"
                            viewBox="0 0 24 24"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="2"
                            strokeLinecap="round"
                            aria-hidden="true"
                          >
                            <circle cx="12" cy="12" r="9" />
                            <line x1="12" y1="7" x2="12" y2="13" />
                            <line x1="12" y1="17" x2="12" y2="17" />
                          </svg>
                        ) : copied ? (
                          <svg
                            width="12"
                            height="12"
                            viewBox="0 0 24 24"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="2"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            aria-hidden="true"
                          >
                            <polyline points="20 6 9 17 4 12" />
                          </svg>
                        ) : (
                          <svg
                            width="12"
                            height="12"
                            viewBox="0 0 24 24"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="2"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            aria-hidden="true"
                          >
                            <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
                            <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
                          </svg>
                        )}
                      </button>
                    );
                  };
                  const sessionInfoSection = (
                    <div style={{ minWidth: 0 }}>
                      <div style={{ fontSize: 12, fontWeight: 700, color: "var(--text)", marginBottom: 6 }}>
                        {t("sessionInfo", "Session info")}
                      </div>
                      <div
                        style={{
                          display: "grid",
                          gridTemplateColumns: "auto minmax(0, 1fr) auto",
                          columnGap: 12,
                          rowGap: 8,
                          alignItems: "start",
                        }}
                      >
                        {sessionRows.map((row) => (
                          <div key={`session-info:${row.label}`} style={{ display: "contents" }}>
                            <div style={{ color: "var(--text-dim)", whiteSpace: "nowrap" }}>{row.label}</div>
                            <div
                              style={{
                                color: "var(--text-muted)",
                                minWidth: 0,
                                overflowWrap: "anywhere",
                                wordBreak: "break-word",
                                whiteSpace: "normal",
                              }}
                            >
                              {row.value}
                            </div>
                            <div>{row.copyField ? copyButton(row.copyField, row.value) : null}</div>
                          </div>
                        ))}
                      </div>
                      {sessionCopyFeedback?.status === "error" && (
                        <div role="alert" style={{ marginTop: 8, color: "var(--error, #ef4444)" }}>
                          {t("copyFailed", "Copy failed")}.{" "}
                          {t("checkClipboardPermission", "Check clipboard permission and retry.")}
                        </div>
                      )}
                    </div>
                  );

                  return (
                    <div
                      style={{
                        display: "grid",
                        gridTemplateColumns: isMobile
                          ? "1fr"
                          : "minmax(360px, 1.7fr) minmax(140px, 0.55fr) minmax(190px, 0.75fr)",
                        gap: isMobile ? 16 : 24,
                        fontSize: 12,
                        lineHeight: 1.5,
                        fontFamily: "var(--font-mono)",
                      }}
                    >
                      {sessionInfoSection}
                      {section(t("messages", "Messages"), messageRows)}
                      {section(t("tokenStatistics", "Tokens"), [...tokenRows, ...extraTokenRows], "right", true)}
                    </div>
                  );
                })()
              ) : (
                <div style={{ fontSize: 12, color: "var(--text-muted)", fontStyle: "italic" }}>
                  {t("loadSessionInfoHint", "Send a message or run /session to load session info")}
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </>
  );
}
