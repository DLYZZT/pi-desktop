import { useCallback, useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { call, subscribe } from "@/lib/api-client";
import { copyText } from "@/lib/clipboard";
import { useI18n } from "@/i18n";
import { runTerminalControlFlow } from "./terminal-control-flow";
import { getTerminalViewState, terminalCloseOwnershipState, terminalFrameDisposition } from "./terminal-view-state";
import { herdrErrorLabel } from "./herdr-ui-copy";
import { useHerdrFleet } from "@/hooks/useHerdrFleet";
import { useHerdrRuntime } from "@/hooks/useHerdrRuntime";
import type { HerdrPane, HerdrTerminalState, HerdrTerminalStatus } from "@contract/herdr";

const TERMINAL_RESIZE_DEBOUNCE_MS = 180;
const COPY_BUFFER_LINES = 240;

interface TerminalDockProps {
  pane: HerdrPane | null;
  visible: boolean;
  expanded: boolean;
  onToggleExpanded: () => void;
  onPaneUnavailable: () => void;
}

export function TerminalDock({ pane, visible, expanded, onToggleExpanded, onPaneUnavailable }: TerminalDockProps) {
  const { t } = useI18n();
  const { runtime } = useHerdrRuntime();
  const runtimeReady = runtime?.status === "ready";
  const { fleet, refresh: refreshFleet } = useHerdrFleet(runtimeReady && Boolean(pane));
  const mountRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const terminalIdRef = useRef<string | null>(null);
  const modeRef = useRef<"observe" | "control">("observe");
  const releaseControlOnViewCloseRef = useRef(runtime?.releaseControlOnViewClose ?? true);
  const visibleRef = useRef(visible);
  const paneIdRef = useRef<string | undefined>(pane?.id);
  const openGenerationRef = useRef(0);
  const mountedRef = useRef(true);
  const resizeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const copiedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reopenObserveRef = useRef<() => Promise<void>>(async () => undefined);
  const followingRef = useRef(true);
  const dimensionsRef = useRef({ cols: 0, rows: 0 });
  const renderedPaneIdRef = useRef<string | null>(null);
  const lastSeqRef = useRef<number | null>(null);
  const streamRecoveryRef = useRef(false);
  const frameSubscriptionRef = useRef<(() => void) | null>(null);
  const statusSubscriptionRef = useRef<(() => void) | null>(null);
  const frameSubscriptionGenerationRef = useRef(0);
  const statusSubscriptionGenerationRef = useRef(0);
  const [status, setStatus] = useState<HerdrTerminalStatus | null>(null);
  const [ownershipState, setOwnershipState] = useState<"controlled-elsewhere" | "controller-lost" | null>(null);
  const [opening, setOpening] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [subscriptionsReady, setSubscriptionsReady] = useState(false);
  const [frameSubscriptionReady, setFrameSubscriptionReady] = useState(false);
  const [statusSubscriptionReady, setStatusSubscriptionReady] = useState(false);
  const [streamTerminalId, setStreamTerminalId] = useState<string | null>(null);
  const [dimensions, setDimensions] = useState({ cols: 0, rows: 0 });
  const [following, setFollowing] = useState(true);
  const [copied, setCopied] = useState(false);
  const paneId = pane?.id;
  visibleRef.current = visible;
  paneIdRef.current = paneId;
  releaseControlOnViewCloseRef.current = runtime?.releaseControlOnViewClose ?? true;

  const setFollowingState = useCallback((next: boolean) => {
    followingRef.current = next;
    setFollowing(next);
  }, []);

  const closeTerminalById = useCallback(async (terminalId: string, release: boolean) => {
    try {
      await call("herdr.terminal.close", { terminalId, release });
    } catch {
      // Host shutdown and pane closure are already terminal conditions.
    }
  }, []);

  const close = useCallback(
    async (release = true) => {
      const operation = ++openGenerationRef.current;
      const terminalId = terminalIdRef.current;
      terminalIdRef.current = null;
      lastSeqRef.current = null;
      streamRecoveryRef.current = false;
      setStreamTerminalId(null);
      if (resizeTimerRef.current) {
        clearTimeout(resizeTimerRef.current);
        resizeTimerRef.current = null;
      }
      if (terminalRef.current) {
        terminalRef.current.options.disableStdin = true;
        terminalRef.current.options.cursorBlink = false;
        terminalRef.current.options.cursorInactiveStyle = "none";
      }
      if (terminalId) await closeTerminalById(terminalId, release);
      if (mountedRef.current && operation === openGenerationRef.current) {
        setOpening(false);
        setStatus(null);
      }
    },
    [closeTerminalById],
  );

  const open = useCallback(
    async (mode: "observe" | "control", takeover = false, preserveOwnership = false) => {
      if (!visibleRef.current || !paneId || !terminalRef.current || !fitRef.current) return;
      const operation = ++openGenerationRef.current;
      const requestedPaneId = paneId;
      setOpening(true);
      setStatus(null);
      setError(null);
      if (!preserveOwnership) setOwnershipState(null);
      const previousTerminalId = terminalIdRef.current;
      terminalIdRef.current = null;
      if (previousTerminalId) await closeTerminalById(previousTerminalId, true);
      if (operation !== openGenerationRef.current || !visibleRef.current || requestedPaneId !== paneIdRef.current) {
        if (operation === openGenerationRef.current && mountedRef.current) setOpening(false);
        return;
      }
      const terminal = terminalRef.current;
      const fit = fitRef.current;
      if (!terminal || !fit) {
        if (operation === openGenerationRef.current && mountedRef.current) setOpening(false);
        return;
      }
      if (renderedPaneIdRef.current !== requestedPaneId) {
        terminal.reset();
        renderedPaneIdRef.current = requestedPaneId;
      }
      fit.fit();
      dimensionsRef.current = { cols: terminal.cols, rows: terminal.rows };
      setDimensions(dimensionsRef.current);
      setFollowingState(true);
      try {
        const result = await call("herdr.terminal.open", {
          paneId: requestedPaneId,
          mode,
          cols: Math.max(1, terminal.cols),
          rows: Math.max(1, terminal.rows),
          takeover,
        });
        if (operation !== openGenerationRef.current || !visibleRef.current || requestedPaneId !== paneIdRef.current) {
          await closeTerminalById(result.terminalId, true);
          return;
        }
        terminalIdRef.current = result.terminalId;
        lastSeqRef.current = null;
        streamRecoveryRef.current = false;
        setStreamTerminalId(result.terminalId);
        modeRef.current = mode;
        terminal.options.disableStdin = mode !== "control";
        terminal.options.cursorBlink = mode === "control";
        terminal.options.cursorInactiveStyle = mode === "control" ? "outline" : "none";
        if (mode === "observe") terminal.blur();
        const nextState =
          mode === "control" ? (result.controller ? "controlling" : "controlled-elsewhere") : "observing";
        setOwnershipState(nextState === "controlled-elsewhere" ? nextState : null);
        setStatus({
          terminalId: result.terminalId,
          paneId: requestedPaneId,
          state: nextState,
          mode,
          controller: result.controller,
          ansiOnly: true,
        });
      } catch (nextError) {
        if (operation === openGenerationRef.current && mountedRef.current) {
          setError(herdrErrorLabel(nextError, t));
        }
        return typeof nextError === "object" && nextError !== null && "code" in nextError
          ? String((nextError as { code?: unknown }).code)
          : "HERDR_INTERNAL";
      } finally {
        if (operation === openGenerationRef.current && mountedRef.current) setOpening(false);
      }
    },
    [closeTerminalById, paneId, setFollowingState, t],
  );

  const takeControl = useCallback(async () => {
    await runTerminalControlFlow({
      confirmInitial: () =>
        window.confirm(t("takeTerminalControlConfirm", "Take keyboard control of this Herdr pane?")),
      confirmTakeover: () =>
        window.confirm(
          t(
            "takeTerminalControlBusyConfirm",
            "Another client controls this pane. Take over and disconnect that controller?",
          ),
        ),
      openControl: (takeover) => open("control", takeover),
      restoreObserve: () => open("observe", false, true),
      onBusy: () => setOwnershipState("controlled-elsewhere"),
    });
  }, [open, t]);

  useEffect(() => {
    reopenObserveRef.current = async () => {
      await open("observe");
    };
  }, [open]);

  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) return;
    const terminal = new Terminal({
      allowProposedApi: false,
      allowTransparency: false,
      convertEol: false,
      cursorBlink: false,
      cursorInactiveStyle: "none",
      cursorStyle: "block",
      disableStdin: true,
      drawBoldTextInBrightColors: true,
      fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
      fontSize: 13,
      letterSpacing: 0.15,
      lineHeight: 1.22,
      minimumContrastRatio: 5,
      scrollback: 10_000,
      scrollOnUserInput: true,
      theme: {
        background: "#09101d",
        foreground: "#dbe7f3",
        cursor: "#93c5fd",
        selectionBackground: "#31577d99",
        black: "#111827",
        brightBlack: "#64748b",
        blue: "#60a5fa",
        brightBlue: "#93c5fd",
        cyan: "#22d3ee",
        brightCyan: "#67e8f9",
        green: "#4ade80",
        brightGreen: "#86efac",
        magenta: "#c084fc",
        brightMagenta: "#d8b4fe",
        red: "#f87171",
        brightRed: "#fca5a5",
        white: "#e2e8f0",
        brightWhite: "#f8fafc",
        yellow: "#facc15",
        brightYellow: "#fde047",
      },
      windowOptions: {},
    });
    const fit = new FitAddon();
    terminal.loadAddon(fit);
    terminal.open(mount);
    const clipboardOsc = terminal.parser.registerOscHandler(52, () => true);
    terminalRef.current = terminal;
    fitRef.current = fit;

    const publishDimensions = () => {
      try {
        fit.fit();
      } catch {
        return;
      }
      const next = { cols: terminal.cols, rows: terminal.rows };
      if (next.cols === dimensionsRef.current.cols && next.rows === dimensionsRef.current.rows) return;
      dimensionsRef.current = next;
      setDimensions(next);
      const terminalId = terminalIdRef.current;
      if (!terminalId) return;
      if (resizeTimerRef.current) clearTimeout(resizeTimerRef.current);
      resizeTimerRef.current = setTimeout(() => {
        if (terminalIdRef.current !== terminalId) return;
        if (modeRef.current === "observe") {
          void reopenObserveRef.current();
          return;
        }
        void call("herdr.terminal.resize", { terminalId, cols: next.cols, rows: next.rows }).catch((nextError) => {
          setError(herdrErrorLabel(nextError, t));
        });
      }, TERMINAL_RESIZE_DEBOUNCE_MS);
    };

    const resizeObserver = new ResizeObserver(publishDimensions);
    resizeObserver.observe(mount);
    const inputDisposable = terminal.onData((data) => {
      const terminalId = terminalIdRef.current;
      if (!terminalId || modeRef.current !== "control") return;
      void call("herdr.terminal.input", { terminalId, bytes: new TextEncoder().encode(data) }).catch((nextError) => {
        setError(herdrErrorLabel(nextError, t));
      });
    });
    const scrollDisposable = terminal.onScroll(() => {
      const buffer = terminal.buffer.active;
      setFollowingState(buffer.viewportY >= buffer.baseY);
    });
    return () => {
      resizeObserver.disconnect();
      inputDisposable.dispose();
      scrollDisposable.dispose();
      clipboardOsc.dispose();
      if (resizeTimerRef.current) clearTimeout(resizeTimerRef.current);
      terminal.dispose();
      terminalRef.current = null;
      fitRef.current = null;
    };
  }, [setFollowingState, t]);

  const handleTerminalFrame = useCallback(
    (frame: { terminalId: string; seq: number; full: boolean; bytes: Uint8Array }) => {
      const terminal = terminalRef.current;
      if (frame.terminalId !== terminalIdRef.current || !terminal) return;
      const previousSeq = lastSeqRef.current;
      const disposition = terminalFrameDisposition(previousSeq, frame.seq, frame.full);
      if (disposition === "duplicate") {
        void call("herdr.terminal.ack", { terminalId: frame.terminalId, seq: frame.seq }).catch(() => undefined);
        return;
      }
      if (disposition === "gap") {
        if (!streamRecoveryRef.current) {
          streamRecoveryRef.current = true;
          setError(herdrErrorLabel({ code: "HERDR_TERMINAL_STREAM_INVALID" }, t));
          const terminalId = frame.terminalId;
          terminalIdRef.current = null;
          lastSeqRef.current = null;
          setStreamTerminalId(null);
          void closeTerminalById(terminalId, true).finally(() => {
            if (!visibleRef.current || !paneIdRef.current) return;
            void reopenObserveRef.current();
          });
        }
        return;
      }
      lastSeqRef.current = frame.seq;
      if (frame.full) terminal.write("\x1b[2J\x1b[H");
      terminal.write(frame.bytes, () => {
        if (followingRef.current) terminal.scrollToBottom();
        void call("herdr.terminal.ack", { terminalId: frame.terminalId, seq: frame.seq }).catch(() => undefined);
      });
    },
    [closeTerminalById, t],
  );

  const handleTerminalStatus = useCallback(
    (nextStatus: HerdrTerminalStatus) => {
      if (nextStatus.terminalId !== terminalIdRef.current) return;
      const recoveryMessage = nextStatus.error ? herdrErrorLabel(nextStatus.error, t) : null;
      const controllerWasHeld = modeRef.current === "control";
      setStatus(nextStatus);
      if (nextStatus.mode) modeRef.current = nextStatus.mode;
      if (nextStatus.state === "controlling" && !nextStatus.controller) {
        setOwnershipState("controlled-elsewhere");
      } else if (nextStatus.state === "controlling") {
        setOwnershipState(null);
      }
      if (nextStatus.error) setError(recoveryMessage);
      if (nextStatus.state === "closed" || nextStatus.state === "error") {
        setOwnershipState(terminalCloseOwnershipState(controllerWasHeld ? "control" : "observe", nextStatus.state));
        terminalIdRef.current = null;
        lastSeqRef.current = null;
        setStreamTerminalId(null);
        if (terminalRef.current) {
          terminalRef.current.options.disableStdin = true;
          terminalRef.current.options.cursorBlink = false;
          terminalRef.current.options.cursorInactiveStyle = "none";
        }
        if (visibleRef.current && paneIdRef.current) void refreshFleet();
        if (nextStatus.recovery === "reopen-observe" && visibleRef.current && paneIdRef.current) {
          setTimeout(() => {
            if (!visibleRef.current || !paneIdRef.current) return;
            void reopenObserveRef.current().finally(() => {
              if (mountedRef.current && recoveryMessage) setError(recoveryMessage);
            });
          }, 0);
        }
      }
    },
    [refreshFleet, t],
  );

  useEffect(() => {
    const generation = ++frameSubscriptionGenerationRef.current;
    let disposed = false;
    void subscribe("herdr.terminal.frame", streamTerminalId ?? "*", handleTerminalFrame)
      .then((release) => {
        if (disposed || generation !== frameSubscriptionGenerationRef.current) {
          release();
          return;
        }
        const previous = frameSubscriptionRef.current;
        frameSubscriptionRef.current = release;
        previous?.();
        setFrameSubscriptionReady(true);
      })
      .catch((nextError) => {
        if (!disposed) setError(herdrErrorLabel(nextError, t));
      });
    return () => {
      disposed = true;
    };
  }, [handleTerminalFrame, streamTerminalId, t]);

  useEffect(() => {
    const generation = ++statusSubscriptionGenerationRef.current;
    let disposed = false;
    void subscribe("herdr.terminal.status", streamTerminalId ?? "*", handleTerminalStatus)
      .then((release) => {
        if (disposed || generation !== statusSubscriptionGenerationRef.current) {
          release();
          return;
        }
        const previous = statusSubscriptionRef.current;
        statusSubscriptionRef.current = release;
        previous?.();
        setStatusSubscriptionReady(true);
      })
      .catch((nextError) => {
        if (!disposed) setError(herdrErrorLabel(nextError, t));
      });
    return () => {
      disposed = true;
    };
  }, [handleTerminalStatus, streamTerminalId, t]);

  useEffect(() => {
    setSubscriptionsReady(frameSubscriptionReady && statusSubscriptionReady);
  }, [frameSubscriptionReady, statusSubscriptionReady]);

  useEffect(
    () => () => {
      frameSubscriptionGenerationRef.current += 1;
      statusSubscriptionGenerationRef.current += 1;
      frameSubscriptionRef.current?.();
      statusSubscriptionRef.current?.();
      frameSubscriptionRef.current = null;
      statusSubscriptionRef.current = null;
    },
    [],
  );

  useEffect(() => {
    if (!visible || !paneId || !terminalRef.current || !subscriptionsReady || !runtimeReady) {
      if (modeRef.current === "control" && terminalIdRef.current) setOwnershipState("controller-lost");
      void close(releaseControlOnViewCloseRef.current);
      return;
    }
    void open("observe");
  }, [close, open, paneId, runtimeReady, subscriptionsReady, visible]);

  useEffect(() => {
    if (!paneId || !runtimeReady || !fleet || fleet.stale) return;
    if (fleet.panes.some((candidate) => candidate.id === paneId)) return;
    void close(releaseControlOnViewCloseRef.current).finally(onPaneUnavailable);
  }, [close, fleet, onPaneUnavailable, paneId, runtimeReady]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      void close(releaseControlOnViewCloseRef.current);
    };
  }, [close]);

  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) return;
    const onPaste = (event: ClipboardEvent) => {
      if (modeRef.current !== "control") return;
      const text = event.clipboardData?.getData("text") ?? "";
      if (text.length <= 4_096) return;
      if (
        !window.confirm(
          t("largeTerminalPasteConfirm", "Paste {count} characters into the Herdr pane?").replace(
            "{count}",
            text.length.toLocaleString(),
          ),
        )
      ) {
        event.preventDefault();
        event.stopPropagation();
      }
    };
    mount.addEventListener("paste", onPaste, true);
    return () => mount.removeEventListener("paste", onPaste, true);
  }, [t]);

  useEffect(
    () => () => {
      if (copiedTimerRef.current) clearTimeout(copiedTimerRef.current);
    },
    [],
  );

  const copyRecentOutput = useCallback(async () => {
    const terminal = terminalRef.current;
    if (!terminal) return;
    const buffer = terminal.buffer.active;
    const start = Math.max(0, buffer.length - COPY_BUFFER_LINES);
    const lines: string[] = [];
    for (let index = start; index < buffer.length; index += 1) {
      lines.push(buffer.getLine(index)?.translateToString(true) ?? "");
    }
    const text = lines.join("\n").trimEnd();
    if (!text) return;
    try {
      await copyText(text);
      setCopied(true);
      if (copiedTimerRef.current) clearTimeout(copiedTimerRef.current);
      copiedTimerRef.current = setTimeout(() => setCopied(false), 1_400);
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : String(nextError));
    }
  }, []);

  const jumpToLatest = useCallback(() => {
    terminalRef.current?.scrollToBottom();
    setFollowingState(true);
  }, [setFollowingState]);

  const state: HerdrTerminalState = getTerminalViewState({ opening, ownershipState, status });
  const stateText = terminalStateLabel(state, t);
  const controlling = status?.mode === "control" && status.state === "controlling";
  const livePane = (pane && fleet?.panes.find((candidate) => candidate.id === pane.id)) || pane;
  const title = livePane?.agent?.name || livePane?.title || livePane?.id || "";
  const detail = livePane ? `${livePane.agent?.kind ?? t("shellPane", "Shell pane")} · ${livePane.id}` : "";

  return (
    <div
      style={{
        height: "100%",
        display: "grid",
        gridTemplateRows: pane ? "auto minmax(0, 1fr) auto" : "minmax(0, 1fr)",
        background: "#09101d",
      }}
    >
      {pane && (
        <div
          style={{
            minHeight: 52,
            display: "flex",
            alignItems: "center",
            flexWrap: "wrap",
            gap: 9,
            padding: "7px 9px 7px 11px",
            borderBottom: "1px solid #243247",
            background: "#111a2a",
          }}
        >
          <div style={{ minWidth: 150, flex: "1 1 180px" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 7, minWidth: 0 }}>
              <span
                style={{
                  minWidth: 0,
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                  color: "#edf5fd",
                  fontSize: 12,
                  fontWeight: 650,
                }}
              >
                {title}
              </span>
              <span role="status" aria-live="polite" style={statusBadgeStyle(state)}>
                <span aria-hidden="true" style={{ ...statusDotStyle, background: terminalStateColor(state) }} />
                {stateText}
              </span>
            </div>
            <div
              title={detail}
              style={{
                marginTop: 3,
                color: "#8496ad",
                fontFamily: "var(--font-mono)",
                fontSize: 10,
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
            >
              {detail}
            </div>
          </div>

          <div style={{ display: "flex", alignItems: "center", gap: 6, flexShrink: 0 }}>
            {controlling ? (
              <button
                type="button"
                disabled={opening}
                style={toolbarButtonStyle("neutral", opening)}
                onClick={() => void open("observe")}
              >
                {t("releaseControl", "Release control")}
              </button>
            ) : (
              <button
                type="button"
                disabled={opening}
                style={toolbarButtonStyle("control", opening)}
                onClick={() => void takeControl()}
              >
                {t("takeControl", "Take control")}
              </button>
            )}
            <button
              type="button"
              disabled={opening}
              style={toolbarButtonStyle("neutral", opening)}
              onClick={() => void open("observe")}
            >
              {t("reconnectTerminal", "Reconnect")}
            </button>
            <button type="button" style={toolbarButtonStyle("neutral", false)} onClick={onToggleExpanded}>
              {expanded ? t("restoreTerminal", "Restore") : t("expandTerminal", "Expand")}
            </button>
          </div>
        </div>
      )}

      <div style={{ minHeight: 0, position: "relative", background: "#09101d" }}>
        <div
          ref={mountRef}
          aria-label={t("herdrTerminalViewport", "Herdr terminal viewport")}
          style={{
            position: "absolute",
            inset: 10,
            overflow: "hidden",
            borderRadius: 5,
            opacity: pane && visible ? 1 : 0,
            pointerEvents: pane && visible ? "auto" : "none",
          }}
        />
        {!pane && (
          <div style={{ ...emptyStyle, position: "absolute", inset: 0 }}>
            <div style={{ maxWidth: 280, textAlign: "center" }}>
              <div style={{ color: "var(--text)", fontSize: 13, fontWeight: 650 }}>
                {t("noTerminalPaneSelected", "No terminal pane selected")}
              </div>
              <div style={{ marginTop: 7, lineHeight: 1.6 }}>
                {t("selectHerdrPane", "Select a Herdr pane to inspect or control it.")}
              </div>
            </div>
          </div>
        )}
        {error && (
          <div
            role="alert"
            style={{
              position: "absolute",
              left: 12,
              right: 12,
              bottom: 12,
              padding: "9px 10px",
              border: "1px solid rgba(248,113,113,.35)",
              borderRadius: 7,
              background: "rgba(69,10,10,.94)",
              boxShadow: "0 8px 22px rgba(0,0,0,.24)",
              color: "#fecaca",
              fontSize: 11,
              lineHeight: 1.45,
            }}
          >
            {error}
          </div>
        )}
      </div>

      {pane && (
        <div
          style={{
            minHeight: 30,
            padding: "0 10px",
            display: "flex",
            alignItems: "center",
            gap: 9,
            borderTop: "1px solid #243247",
            background: "#0f1827",
            color: "#8496ad",
            fontFamily: "var(--font-mono)",
            fontSize: 9,
            fontVariantNumeric: "tabular-nums",
          }}
        >
          <span style={{ color: controlling ? "#fbbf24" : "#93c5fd", fontWeight: 700 }}>
            {controlling ? t("terminalControlMode", "CONTROL") : t("terminalObserveMode", "OBSERVE")}
          </span>
          <span>{dimensions.cols > 0 && dimensions.rows > 0 ? `${dimensions.cols}×${dimensions.rows}` : "—"}</span>
          <span>{t("terminalAnsiLabel", "ANSI")}</span>
          <span style={{ minWidth: 0, flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {controlling
              ? t("terminalKeyboardEnabled", "Keyboard input enabled")
              : t("terminalReadOnly", "Read-only observation")}
          </span>
          <button type="button" style={footerButtonStyle} onClick={() => void copyRecentOutput()}>
            {copied ? t("copied", "Copied") : t("copyRecentOutput", "Copy output")}
          </button>
          {!following && (
            <button type="button" style={footerButtonStyle} onClick={jumpToLatest}>
              {t("jumpToLatest", "Jump to latest")}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function terminalStateLabel(state: HerdrTerminalState, t: (key: string, fallback: string) => string): string {
  if (state === "opening") return t("terminalStateOpening", "Connecting");
  if (state === "observing") return t("terminalStateObserving", "Observing");
  if (state === "controlling") return t("terminalStateControlling", "Controlling");
  if (state === "controlled-elsewhere") return t("terminalStateControlledElsewhere", "Controlled elsewhere");
  if (state === "controller-lost") return t("terminalStateControllerLost", "Control lost");
  if (state === "error") return t("terminalStateError", "Error");
  return t("terminalStateClosed", "Disconnected");
}

function terminalStateColor(state: HerdrTerminalState): string {
  if (state === "observing") return "#60a5fa";
  if (state === "controlling") return "#fbbf24";
  if (state === "controlled-elsewhere") return "#fb923c";
  if (state === "controller-lost") return "#f87171";
  if (state === "error") return "#f87171";
  if (state === "opening") return "#a78bfa";
  return "#64748b";
}

function statusBadgeStyle(state: HerdrTerminalState): React.CSSProperties {
  const color = terminalStateColor(state);
  return {
    height: 19,
    padding: "0 6px",
    display: "inline-flex",
    alignItems: "center",
    gap: 5,
    flexShrink: 0,
    border: `1px solid color-mix(in srgb, ${color} 38%, #334155)`,
    borderRadius: 999,
    background: `color-mix(in srgb, ${color} 10%, #111a2a)`,
    color: "#cbd9e8",
    fontSize: 9,
    fontWeight: 650,
  };
}

function toolbarButtonStyle(tone: "neutral" | "control", disabled: boolean): React.CSSProperties {
  const control = tone === "control";
  return {
    minHeight: 29,
    padding: "0 9px",
    border: `1px solid ${control ? "#a16207" : "#334155"}`,
    borderRadius: 6,
    background: control ? "#422006" : "#172235",
    color: control ? "#fde68a" : "#dbe7f3",
    cursor: disabled ? "default" : "pointer",
    fontSize: 10,
    fontWeight: control ? 650 : 500,
    opacity: disabled ? 0.58 : 1,
    whiteSpace: "nowrap",
  };
}

const footerButtonStyle: React.CSSProperties = {
  height: 22,
  padding: "0 6px",
  flexShrink: 0,
  border: "none",
  borderRadius: 4,
  background: "transparent",
  color: "#a9bad0",
  cursor: "pointer",
  fontFamily: "var(--font-sans)",
  fontSize: 9,
};
const statusDotStyle: React.CSSProperties = { width: 6, height: 6, borderRadius: "50%", flexShrink: 0 };
const emptyStyle: React.CSSProperties = {
  height: "100%",
  display: "grid",
  placeItems: "center",
  padding: 20,
  background: "var(--bg)",
  color: "var(--text-muted)",
  fontSize: 12,
};
