import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ManagedProcessLogRecord, ManagedProcessLogStream, ManagedProcessPublicInfo } from "@contract/processes";
import { isManagedProcessActiveState } from "@contract/processes";
import { call, subscribe } from "@/lib/api-client";
import { copyText } from "@/lib/clipboard";
import { useI18n } from "@/i18n";

type Props = {
  onActiveCountChange?: (count: number) => void;
  onOpenBrowser?: () => void;
};

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function formatDuration(startedAt: number | undefined, stoppedAt: number | undefined, now: number): string {
  if (!startedAt) return "—";
  const seconds = Math.max(0, Math.floor(((stoppedAt ?? now) - startedAt) / 1_000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

function stateColor(process: ManagedProcessPublicInfo): string {
  if (process.state === "ready") return "#4ade80";
  if (isManagedProcessActiveState(process.state)) return "#60a5fa";
  if (process.state === "exited" && process.exit?.code === 0) return "var(--text-dim)";
  if (process.state === "killed" || process.state === "reaped") return "#fbbf24";
  return "#f87171";
}

const buttonStyle = {
  height: 28,
  border: "1px solid var(--border)",
  borderRadius: 6,
  background: "var(--bg-panel)",
  color: "var(--text-muted)",
  padding: "0 9px",
  fontSize: 11,
  cursor: "pointer",
} as const;

export function ProcessPanel({ onActiveCountChange, onOpenBrowser }: Props) {
  const { t } = useI18n();
  const [processes, setProcesses] = useState<ManagedProcessPublicInfo[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [records, setRecords] = useState<ManagedProcessLogRecord[]>([]);
  const [cursor, setCursor] = useState<string | undefined>();
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [streams, setStreams] = useState<Set<ManagedProcessLogStream>>(() => new Set(["stdout", "stderr", "system"]));
  const [stdin, setStdin] = useState("");
  const [now, setNow] = useState(Date.now());
  const listRevisionRef = useRef(0);
  const cursorRef = useRef<string | undefined>(undefined);
  const selectedIdRef = useRef<string | null>(null);
  const refreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const logRef = useRef<HTMLDivElement | null>(null);

  const selected = processes.find((process) => process.processId === selectedId) ?? null;
  const selectedProcessId = selected?.processId ?? null;
  const selectedRunId = selected?.runId ?? null;
  selectedIdRef.current = selectedId;
  cursorRef.current = cursor;

  const refresh = useCallback(async () => {
    try {
      const snapshot = await call("processes.list", { includeExited: true });
      listRevisionRef.current = Math.max(listRevisionRef.current, snapshot.revision);
      setProcesses(snapshot.processes);
      onActiveCountChange?.(snapshot.processes.filter((process) => isManagedProcessActiveState(process.state)).length);
      setSelectedId((current) =>
        current && snapshot.processes.some((process) => process.processId === current)
          ? current
          : (snapshot.processes[0]?.processId ?? null),
      );
      setError(null);
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setLoading(false);
    }
  }, [onActiveCountChange]);

  const scheduleRefresh = useCallback(() => {
    if (refreshTimerRef.current) return;
    refreshTimerRef.current = setTimeout(() => {
      refreshTimerRef.current = null;
      void refresh();
    }, 100);
  }, [refresh]);

  const readMore = useCallback(async (processId: string, runId: string, fromCursor?: string, reset = false) => {
    try {
      const result = await call("processes.read", {
        processId,
        runId,
        cursor: fromCursor,
        maxBytes: 256 * 1024,
        streams: ["stdout", "stderr", "system"],
      });
      if (selectedIdRef.current !== processId) return;
      setRecords((current) => {
        const next = reset ? result.records : [...current, ...result.records];
        const deduped = new Map(next.map((record) => [`${record.runId}:${record.seq}`, record]));
        return [...deduped.values()].slice(-2_000);
      });
      setCursor(result.nextCursor);
      setHasMore(result.truncated);
      setError(null);
      requestAnimationFrame(() => {
        const element = logRef.current;
        if (element && element.scrollHeight - element.scrollTop - element.clientHeight < 160) {
          element.scrollTop = element.scrollHeight;
        }
      });
    } catch (cause) {
      setError(messageOf(cause));
    }
  }, []);

  useEffect(() => {
    void refresh();
    let disposed = false;
    let unsubscribe: (() => void) | undefined;
    void subscribe("processes.changed", "*", (event) => {
      if (event.revision <= listRevisionRef.current) return;
      scheduleRefresh();
    }).then((value) => {
      if (disposed) value();
      else unsubscribe = value;
    });
    return () => {
      disposed = true;
      unsubscribe?.();
      if (refreshTimerRef.current) clearTimeout(refreshTimerRef.current);
    };
  }, [refresh, scheduleRefresh]);

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    setRecords([]);
    setCursor(undefined);
    setHasMore(false);
    if (!selectedProcessId || !selectedRunId) return;
    void readMore(selectedProcessId, selectedRunId, undefined, true);
    let disposed = false;
    let unsubscribe: (() => void) | undefined;
    void subscribe("processes.output", selectedProcessId, (event) => {
      if (event.runId !== selectedRunId) return;
      void readMore(selectedProcessId, selectedRunId, cursorRef.current);
    }).then((value) => {
      if (disposed) value();
      else unsubscribe = value;
    });
    return () => {
      disposed = true;
      unsubscribe?.();
    };
  }, [readMore, selectedProcessId, selectedRunId]);

  const filteredRecords = useMemo(() => {
    const needle = search.trim().toLocaleLowerCase();
    return records.filter(
      (record) => streams.has(record.stream) && (!needle || record.text.toLocaleLowerCase().includes(needle)),
    );
  }, [records, search, streams]);

  const invoke = async (operation: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await operation();
      await refresh();
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setBusy(false);
    }
  };

  const openEndpoint = async (process: ManagedProcessPublicInfo, url: string) => {
    setBusy(true);
    try {
      const tab = await window.piBridge.browserCreateUserTab({
        url,
        ownerSessionId: process.ownerSessionId,
        activate: true,
      });
      window.dispatchEvent(new CustomEvent("pi-desktop:open-browser-tab", { detail: { tabId: tab.id } }));
      onOpenBrowser?.();
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{ height: "100%", display: "flex", flexDirection: "column", minWidth: 0 }}>
      <div
        aria-live="polite"
        style={{ position: "absolute", width: 1, height: 1, overflow: "hidden", clip: "rect(0 0 0 0)" }}
      >
        {selected ? `${selected.label}: ${selected.state}` : t("noManagedProcesses", "No managed processes")}
      </div>
      {error && (
        <div
          role="alert"
          style={{ padding: "8px 10px", color: "#f87171", fontSize: 11, borderBottom: "1px solid var(--border)" }}
        >
          {error}
        </div>
      )}
      <div style={{ display: "grid", gridTemplateColumns: "minmax(120px, 32%) minmax(0, 1fr)", flex: 1, minHeight: 0 }}>
        <div style={{ borderRight: "1px solid var(--border)", overflowY: "auto", background: "var(--bg-panel)" }}>
          {loading ? (
            <div style={{ padding: 14, color: "var(--text-dim)", fontSize: 12 }}>{t("loading", "Loading…")}</div>
          ) : processes.length === 0 ? (
            <div style={{ padding: 14, color: "var(--text-dim)", fontSize: 12, lineHeight: 1.6 }}>
              {t("noManagedProcesses", "No managed processes")}
            </div>
          ) : (
            processes.map((process) => (
              <button
                type="button"
                key={process.processId}
                onClick={() => setSelectedId(process.processId)}
                style={{
                  width: "100%",
                  border: "none",
                  borderBottom: "1px solid var(--border)",
                  background: selectedId === process.processId ? "var(--bg)" : "transparent",
                  color: "var(--text)",
                  padding: "10px",
                  textAlign: "left",
                  cursor: "pointer",
                }}
              >
                <div style={{ display: "flex", gap: 7, alignItems: "center", minWidth: 0 }}>
                  <span
                    style={{ width: 7, height: 7, borderRadius: "50%", background: stateColor(process), flexShrink: 0 }}
                  />
                  <span
                    style={{
                      fontSize: 12,
                      fontWeight: 600,
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {process.label}
                  </span>
                </div>
                <div
                  style={{
                    marginTop: 5,
                    fontSize: 10,
                    color: "var(--text-dim)",
                    display: "flex",
                    justifyContent: "space-between",
                  }}
                >
                  <span>{process.state}</span>
                  <span>{formatDuration(process.startedAt, process.stoppedAt, now)}</span>
                </div>
                {process.lastOutput && (
                  <div
                    style={{
                      marginTop: 6,
                      fontSize: 10,
                      color: "var(--text-dim)",
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {process.lastOutput.text}
                  </div>
                )}
              </button>
            ))
          )}
        </div>

        {selected ? (
          <div style={{ display: "flex", flexDirection: "column", minWidth: 0, minHeight: 0 }}>
            <div style={{ padding: "10px 12px", borderBottom: "1px solid var(--border)", display: "grid", gap: 7 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <strong style={{ fontSize: 13, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {selected.label}
                </strong>
                <span style={{ color: stateColor(selected), fontSize: 11 }}>{selected.state}</span>
                <span style={{ marginLeft: "auto", color: "var(--text-dim)", fontSize: 10 }}>
                  run {selected.generation}
                </span>
              </div>
              <div
                title={selected.commandDisplay}
                style={{
                  color: "var(--text-muted)",
                  fontFamily: "var(--font-mono)",
                  fontSize: 10,
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
              >
                {selected.commandDisplay}
              </div>
              <div style={{ color: "var(--text-dim)", fontSize: 10 }}>
                {selected.cwdDisplay} · {selected.kind} · {selected.readiness}
                {selected.exit ? ` · exit ${selected.exit.code ?? selected.exit.signal ?? "unknown"}` : ""}
              </div>
              <div style={{ color: "var(--text-dim)", fontSize: 10 }} title={selected.ownerSessionId}>
                {t("ownerTask", "Owner task")}: {selected.ownerSessionId.slice(-12)}
              </div>
              {selected.networkWarnings.map((warning) => (
                <div key={warning} style={{ color: "#fbbf24", fontSize: 10 }}>
                  {warning === "Process may be reachable from the local network"
                    ? t("managedProcessLanWarning", "Process may be reachable from the local network")
                    : warning}
                </div>
              ))}
              {selected.endpoints.map((endpoint) => (
                <button
                  key={endpoint.id}
                  type="button"
                  disabled={busy}
                  onClick={() => void openEndpoint(selected, endpoint.url)}
                  style={{ ...buttonStyle, textAlign: "left", overflow: "hidden", textOverflow: "ellipsis" }}
                >
                  {t("openInBrowser", "Open in Browser")}: {endpoint.url}
                </button>
              ))}
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                {isManagedProcessActiveState(selected.state) ? (
                  <>
                    <button
                      type="button"
                      disabled={busy}
                      style={buttonStyle}
                      onClick={() =>
                        void invoke(() =>
                          call("processes.stop", {
                            processId: selected.processId,
                            runId: selected.runId,
                            mode: "graceful",
                          }),
                        )
                      }
                    >
                      {t("stop", "Stop")}
                    </button>
                    <button
                      type="button"
                      disabled={busy}
                      style={buttonStyle}
                      onClick={() =>
                        void invoke(() =>
                          call("processes.stop", {
                            processId: selected.processId,
                            runId: selected.runId,
                            mode: "force",
                          }),
                        )
                      }
                    >
                      {t("forceStop", "Force Stop")}
                    </button>
                    <button
                      type="button"
                      disabled={busy}
                      style={buttonStyle}
                      onClick={() =>
                        void invoke(() =>
                          call("processes.restart", {
                            processId: selected.processId,
                            runId: selected.runId,
                          }),
                        )
                      }
                    >
                      {t("restart", "Restart")}
                    </button>
                  </>
                ) : (
                  <>
                    <button
                      type="button"
                      disabled={busy}
                      style={buttonStyle}
                      onClick={() =>
                        void invoke(() =>
                          call("processes.restart", { processId: selected.processId, runId: selected.runId }),
                        )
                      }
                    >
                      {t("restart", "Restart")}
                    </button>
                    <button
                      type="button"
                      disabled={busy}
                      style={buttonStyle}
                      onClick={() => void invoke(() => call("processes.dismiss", { processId: selected.processId }))}
                    >
                      {t("dismiss", "Dismiss")}
                    </button>
                  </>
                )}
                <button
                  type="button"
                  disabled={busy}
                  style={buttonStyle}
                  onClick={() =>
                    void invoke(() =>
                      call("processes.export", {
                        processId: selected.processId,
                        runId: selected.runId,
                        streams: [...streams],
                      }),
                    )
                  }
                >
                  {t("exportLogs", "Export Logs")}
                </button>
              </div>
            </div>

            <div
              style={{
                padding: "7px 9px",
                display: "flex",
                gap: 6,
                borderBottom: "1px solid var(--border)",
                alignItems: "center",
                flexWrap: "wrap",
              }}
            >
              <input
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder={t("searchLogs", "Search logs")}
                style={{
                  flex: 1,
                  minWidth: 100,
                  height: 26,
                  border: "1px solid var(--border)",
                  borderRadius: 6,
                  background: "var(--bg)",
                  color: "var(--text)",
                  padding: "0 7px",
                  fontSize: 11,
                }}
              />
              {(["stdout", "stderr", "system"] as ManagedProcessLogStream[]).map((stream) => (
                <label
                  key={stream}
                  style={{ fontSize: 10, color: "var(--text-muted)", display: "flex", gap: 3, alignItems: "center" }}
                >
                  <input
                    type="checkbox"
                    checked={streams.has(stream)}
                    onChange={(event) =>
                      setStreams((current) => {
                        const next = new Set(current);
                        if (event.target.checked) next.add(stream);
                        else next.delete(stream);
                        return next;
                      })
                    }
                  />
                  {stream}
                </label>
              ))}
              <button
                type="button"
                style={buttonStyle}
                onClick={() =>
                  void copyText(filteredRecords.map((record) => `[${record.stream}] ${record.text}`).join("\n"))
                }
              >
                {t("copyVisible", "Copy Visible")}
              </button>
            </div>

            <div
              ref={logRef}
              role="log"
              aria-label={t("managedProcessLogs", "Managed process logs")}
              style={{
                flex: 1,
                minHeight: 0,
                overflow: "auto",
                padding: "8px 10px",
                fontFamily: "var(--font-mono)",
                fontSize: 10.5,
                lineHeight: 1.55,
                whiteSpace: "pre-wrap",
                overflowWrap: "anywhere",
              }}
            >
              {filteredRecords.map((record) => (
                <div
                  key={`${record.runId}:${record.seq}`}
                  style={{
                    color:
                      record.stream === "stderr"
                        ? "#fca5a5"
                        : record.stream === "system"
                          ? "#fbbf24"
                          : "var(--text-muted)",
                  }}
                >
                  <span style={{ color: "var(--text-dim)" }}>[{record.stream}] </span>
                  {record.text}
                </div>
              ))}
              {hasMore && (
                <button
                  type="button"
                  style={{ ...buttonStyle, marginTop: 8 }}
                  onClick={() => void readMore(selected.processId, selected.runId, cursor)}
                >
                  {t("loadMoreLogs", "Load more logs")}
                </button>
              )}
            </div>

            {selected.stdinOpen && isManagedProcessActiveState(selected.state) && (
              <form
                onSubmit={(event) => {
                  event.preventDefault();
                  if (!stdin) return;
                  void invoke(async () => {
                    await call("processes.write", {
                      processId: selected.processId,
                      runId: selected.runId,
                      text: stdin,
                      appendNewline: true,
                    });
                    setStdin("");
                  });
                }}
                style={{ padding: 8, borderTop: "1px solid var(--border)", display: "flex", gap: 6 }}
              >
                <input
                  value={stdin}
                  onChange={(event) => setStdin(event.target.value)}
                  placeholder={t("processStdin", "Send line to stdin")}
                  style={{
                    flex: 1,
                    minWidth: 0,
                    height: 28,
                    border: "1px solid var(--border)",
                    borderRadius: 6,
                    background: "var(--bg)",
                    color: "var(--text)",
                    padding: "0 7px",
                    fontSize: 11,
                  }}
                />
                <button type="submit" disabled={busy || !stdin} style={buttonStyle}>
                  {t("send", "Send")}
                </button>
                <button
                  type="button"
                  disabled={busy}
                  style={buttonStyle}
                  onClick={() =>
                    window.confirm(t("closeStdinConfirm", "Close stdin for this process?")) &&
                    void invoke(() =>
                      call("processes.write", {
                        processId: selected.processId,
                        runId: selected.runId,
                        text: "",
                        appendNewline: false,
                        close: true,
                      }),
                    )
                  }
                >
                  {t("closeStdin", "Close stdin")}
                </button>
              </form>
            )}
          </div>
        ) : (
          <div style={{ display: "grid", placeItems: "center", color: "var(--text-dim)", fontSize: 12 }}>
            {t("noManagedProcesses", "No managed processes")}
          </div>
        )}
      </div>
    </div>
  );
}
