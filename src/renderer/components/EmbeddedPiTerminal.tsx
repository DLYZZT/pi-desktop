import { useEffect, useRef, useState } from "react";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { Terminal } from "@xterm/xterm";
import { copyText } from "@/lib/clipboard";
import type { SessionInfo } from "@/lib/types";
import { TuiDockComposer } from "./TuiDockComposer";
import { nextTuiWorkingSessionIds } from "@/lib/session-sidebar-state";
import {
  EMPTY_DOCK_CHROME,
  parseDockChrome,
  sameDockChrome,
  screenHasLiveStatus,
  type DockChrome,
} from "./tui-dock-rect";
import "@xterm/xterm/css/xterm.css";

type TerminalSession = {
  id: string;
  cwd: string;
  path?: string;
};

type TerminalEntry = {
  cwd: string;
  terminal: Terminal;
  fitAddon: FitAddon;
  element: HTMLDivElement;
  inputDisposable: { dispose: () => void };
  writeParsedDisposable: { dispose: () => void };
  imeRenderDisposable: { dispose: () => void };
  startImeComposition: () => void;
  updateImeComposition: () => void;
  endImeComposition: () => void;
  pinImeOnKey: (event: Event) => void;
  imeStyleObserver: MutationObserver;
};

function disposeTerminalEntry(entry: TerminalEntry): void {
  entry.terminal.textarea?.removeEventListener("keydown", entry.pinImeOnKey, true);
  entry.terminal.textarea?.removeEventListener("compositionstart", entry.startImeComposition, true);
  entry.terminal.textarea?.removeEventListener("compositionupdate", entry.updateImeComposition, true);
  entry.terminal.textarea?.removeEventListener("compositionend", entry.endImeComposition);
  entry.imeStyleObserver.disconnect();
  entry.imeRenderDisposable.dispose();
  entry.writeParsedDisposable.dispose();
  entry.inputDisposable.dispose();
  entry.terminal.dispose();
  entry.element.remove();
}

function lineLooksLikeBorder(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length < 8) return false;
  let box = 0;
  for (const ch of trimmed) {
    if (ch === "\u2500" || ch === "\u2501" || ch === "\u2550" || ch === "-" || ch === "=") box += 1;
  }
  return box / trimmed.length >= 0.6;
}

function readLiveScreenLines(terminal: Terminal): string[] {
  const lines: string[] = [];
  const buffer = terminal.buffer.active;
  const origin = buffer.baseY;
  for (let y = 0; y < terminal.rows; y += 1) {
    lines.push(buffer.getLine(origin + y)?.translateToString(true) ?? "");
  }
  return lines;
}

const COVER_MIN_ROWS = 6;

function cellHeightPx(terminal: Terminal): number {
  const screen = terminal.element?.querySelector<HTMLElement>(".xterm-screen");
  if (!screen || terminal.rows <= 0) return 18;
  return screen.getBoundingClientRect().height / terminal.rows;
}

function applySessionLayout(element: HTMLDivElement): void {
  element.style.position = "absolute";
  element.style.inset = "0";
  element.style.height = "100%";
}

function findImeAnchorCell(terminal: Terminal): { x: number; y: number } {
  const buffer = terminal.buffer.active;
  const cols = terminal.cols;
  const rows = terminal.rows;
  const viewportY = buffer.viewportY;
  const cell = buffer.getNullCell();

  const inverseXOn = (line: NonNullable<ReturnType<typeof buffer.getLine>>): number => {
    for (let x = 0; x < cols; x++) {
      if (line.getCell(x, cell)?.isInverse()) return x;
    }
    return -1;
  };

  let bottomBorderY = -1;
  for (let y = rows - 1; y >= 0; y--) {
    const line = buffer.getLine(viewportY + y);
    if (!line) continue;
    if (lineLooksLikeBorder(line.translateToString(true))) {
      bottomBorderY = y;
      break;
    }
  }

  if (bottomBorderY > 0) {
    for (let y = bottomBorderY - 1; y >= 0; y--) {
      const line = buffer.getLine(viewportY + y);
      if (!line) break;
      if (lineLooksLikeBorder(line.translateToString(true))) break;
      const inverseX = inverseXOn(line);
      if (inverseX >= 0) return { x: inverseX, y };
    }
    const inputLine = buffer.getLine(viewportY + bottomBorderY - 1);
    if (inputLine) {
      let end = 0;
      for (let x = 0; x < cols; x++) {
        const chars = inputLine.getCell(x, cell)?.getChars() ?? "";
        if (chars && chars !== " ") end = x + 1;
      }
      return { x: Math.min(end, cols - 1), y: bottomBorderY - 1 };
    }
  }

  for (let y = rows - 1; y >= 0; y--) {
    const line = buffer.getLine(viewportY + y);
    if (!line) continue;
    const inverseX = inverseXOn(line);
    if (inverseX >= 0) return { x: inverseX, y };
  }

  const hardwareX = buffer.cursorX;
  const hardwareY = Math.min(Math.max(buffer.cursorY, 0), rows - 1);
  if (hardwareX >= 0 && hardwareX < cols / 2) return { x: hardwareX, y: hardwareY };
  return { x: 0, y: Math.max(0, rows - 3) };
}

function applyImeOverlay(terminal: Terminal, locked: { x: number; y: number } | null): { x: number; y: number } | null {
  const textarea = terminal.textarea;
  const host = terminal.element;
  const screen = host?.querySelector<HTMLElement>(".xterm-screen");
  const compositionView = host?.querySelector<HTMLElement>(".composition-view");
  if (!textarea || !screen || terminal.cols <= 0 || terminal.rows <= 0) return locked;

  const bounds = screen.getBoundingClientRect();
  if (bounds.width <= 0 || bounds.height <= 0) return locked;

  const cellWidth = bounds.width / terminal.cols;
  const cellHeight = bounds.height / terminal.rows;
  const anchor = locked ?? findImeAnchorCell(terminal);
  const left = `${anchor.x * cellWidth}px`;
  const top = `${anchor.y * cellHeight}px`;
  if (textarea.style.left !== left) textarea.style.left = left;
  if (textarea.style.top !== top) textarea.style.top = top;
  if (!locked) {
    const width = `${Math.max(cellWidth, 1)}px`;
    const height = `${Math.max(cellHeight, 1)}px`;
    if (textarea.style.width !== width) textarea.style.width = width;
    if (textarea.style.height !== height) textarea.style.height = height;
    if (textarea.style.lineHeight !== height) textarea.style.lineHeight = height;
    if (compositionView) {
      if (compositionView.style.height !== height) compositionView.style.height = height;
      if (compositionView.style.lineHeight !== height) compositionView.style.lineHeight = height;
    }
  }
  if (compositionView) {
    if (compositionView.style.left !== left) compositionView.style.left = left;
    if (compositionView.style.top !== top) compositionView.style.top = top;
  }
  return anchor;
}

function terminalTheme(): {
  background: string;
  foreground: string;
  cursor: string;
  selectionBackground: string;
} {
  const styles = getComputedStyle(document.documentElement);
  const value = (name: string, fallback: string) => styles.getPropertyValue(name).trim() || fallback;
  return {
    background: value("--bg", "#141210"),
    foreground: value("--text", "#e8e4df"),
    cursor: value("--accent", "#d97757"),
    selectionBackground: value("--bg-selected", "#3a332e"),
  };
}

export function EmbeddedPiTerminal({
  session,
  theme,
  worktreeAnchorRef,
  onSessionRelocated,
  onTuiWorkingChange,
}: {
  session: TerminalSession | null;
  theme: "light" | "dark";
  worktreeAnchorRef?: (node: HTMLDivElement | null) => void;
  onSessionRelocated?: (session: SessionInfo) => void;
  onTuiWorkingChange?: (sessionIds: Set<string>) => void;
}) {
  const root = useRef<HTMLDivElement | null>(null);
  const terminalPane = useRef<HTMLDivElement | null>(null);
  const terminals = useRef(new Map<string, TerminalEntry>());
  const selectedSessionId = useRef<string | null>(session?.id ?? null);
  const tuiWorkingRef = useRef(new Set<string>());
  const onTuiWorkingChangeRef = useRef(onTuiWorkingChange);
  onTuiWorkingChangeRef.current = onTuiWorkingChange;
  const publishTuiWorking = (sessionId: string, live: boolean) => {
    const next = nextTuiWorkingSessionIds(tuiWorkingRef.current, sessionId, live);
    if (next === tuiWorkingRef.current) return;
    tuiWorkingRef.current = next;
    onTuiWorkingChangeRef.current?.(next);
  };
  const publishTuiWorkingRef = useRef(publishTuiWorking);
  publishTuiWorkingRef.current = publishTuiWorking;
  const [dockChrome, setDockChrome] = useState<DockChrome>(EMPTY_DOCK_CHROME);
  const [cellPx, setCellPx] = useState(18);
  const [coverOn, setCoverOn] = useState(true);
  const setDockChromeRef = useRef(setDockChrome);
  const chromeTimer = useRef(0);
  setDockChromeRef.current = setDockChrome;

  const publishDockChrome = (terminal: Terminal | null) => {
    if (!terminal || !selectedSessionId.current) {
      setDockChromeRef.current(EMPTY_DOCK_CHROME);
      return;
    }
    const lines = readLiveScreenLines(terminal);
    const nextChrome = parseDockChrome(lines);
    setDockChromeRef.current((prev) => (sameDockChrome(prev, nextChrome) ? prev : nextChrome));
    const nextCell = cellHeightPx(terminal);
    if (Math.abs(nextCell - cellPx) >= 0.5) setCellPx(nextCell);
  };
  const publishDockChromeRef = useRef(publishDockChrome);
  publishDockChromeRef.current = publishDockChrome;

  const scheduleDockChrome = (terminal: Terminal | null) => {
    window.clearTimeout(chromeTimer.current);
    chromeTimer.current = window.setTimeout(() => publishDockChromeRef.current(terminal), 200);
  };
  const scheduleDockChromeRef = useRef(scheduleDockChrome);
  scheduleDockChromeRef.current = scheduleDockChrome;

  useEffect(() => {
    return window.piBridge.onSessionTuiData((payload) => {
      const entry = terminals.current.get(payload.sessionId);
      entry?.terminal.write(payload.data);
      if (payload.sessionId === selectedSessionId.current) scheduleDockChromeRef.current(entry?.terminal ?? null);
    });
  }, []);

  useEffect(() => {
    for (const entry of terminals.current.values()) {
      entry.terminal.options.theme = terminalTheme();
    }
  }, [theme]);

  useEffect(() => {
    selectedSessionId.current = session?.id ?? null;
    const host = terminalPane.current;
    if (!host || !session) {
      setDockChrome(EMPTY_DOCK_CHROME);
      return;
    }

    let entry = terminals.current.get(session.id);
    if (entry && entry.cwd !== session.cwd) {
      disposeTerminalEntry(entry);
      terminals.current.delete(session.id);
      publishTuiWorking(session.id, false);
      entry = undefined;
    }
    if (!entry) {
      const element = document.createElement("div");
      element.className = "embedded-pi-terminal-session";
      element.setAttribute("aria-label", `Pi terminal ${session.id}`);
      applySessionLayout(element);
      host.appendChild(element);

      const terminal = new Terminal({
        cursorBlink: true,
        cursorStyle: "block",
        fontFamily: '"Cascadia Mono", "SFMono-Regular", Consolas, "Liberation Mono", monospace',
        fontSize: 14,
        lineHeight: 1.16,
        scrollback: 10_000,
        theme: terminalTheme(),
      });
      const fitAddon = new FitAddon();
      terminal.loadAddon(fitAddon);
      terminal.loadAddon(
        new WebLinksAddon((event, url) => {
          if (!event.ctrlKey) return;
          void window.piBridge.openExternal(url);
        }),
      );
      terminal.open(element);
      terminal.attachCustomKeyEventHandler((event) => {
        const isPaste = event.type === "keydown" && (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "v";
        if (isPaste) return false;
        const isCopy = event.type === "keydown" && (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "c";
        if (!isCopy || !terminal.hasSelection()) return true;
        void copyText(terminal.getSelection());
        return false;
      });
      let lockedImeAnchor: { x: number; y: number } | null = null;
      const syncImeAnchor = () => {
        applyImeOverlay(terminal, lockedImeAnchor);
      };
      const startImeComposition = () => {
        if (!lockedImeAnchor) lockedImeAnchor = findImeAnchorCell(terminal);
        applyImeOverlay(terminal, lockedImeAnchor);
      };
      const updateImeComposition = () => {
        applyImeOverlay(terminal, lockedImeAnchor);
      };
      const endImeComposition = () => {
        lockedImeAnchor = null;
      };
      const pinImeOnKey = (event: Event) => {
        const keyEvent = event as KeyboardEvent;
        if (!lockedImeAnchor && (keyEvent.isComposing || keyEvent.keyCode === 229)) {
          lockedImeAnchor = findImeAnchorCell(terminal);
        }
        if (lockedImeAnchor) applyImeOverlay(terminal, lockedImeAnchor);
      };
      terminal.textarea?.addEventListener("keydown", pinImeOnKey, true);
      terminal.textarea?.addEventListener("compositionstart", startImeComposition, true);
      terminal.textarea?.addEventListener("compositionupdate", updateImeComposition, true);
      terminal.textarea?.addEventListener("compositionend", endImeComposition);
      const imeStyleObserver = new MutationObserver(() => {
        imeStyleObserver.disconnect();
        syncImeAnchor();
        const textarea = terminal.textarea;
        const compositionView = terminal.element?.querySelector(".composition-view");
        if (textarea) imeStyleObserver.observe(textarea, { attributes: true, attributeFilter: ["style"] });
        if (compositionView)
          imeStyleObserver.observe(compositionView, { attributes: true, attributeFilter: ["style"] });
      });
      if (terminal.textarea) {
        imeStyleObserver.observe(terminal.textarea, { attributes: true, attributeFilter: ["style"] });
      }
      const compositionView = terminal.element?.querySelector(".composition-view");
      if (compositionView) {
        imeStyleObserver.observe(compositionView, { attributes: true, attributeFilter: ["style"] });
      }
      const imeRenderDisposable = terminal.onRender(syncImeAnchor);
      const writeParsedDisposable = terminal.onWriteParsed(() => {
        publishTuiWorkingRef.current(session.id, screenHasLiveStatus(readLiveScreenLines(terminal)));
      });
      const inputDisposable = terminal.onData((data) => {
        window.piBridge.writeSessionTui(session.id, data);
      });
      entry = {
        cwd: session.cwd,
        terminal,
        fitAddon,
        element,
        inputDisposable,
        writeParsedDisposable,
        imeRenderDisposable,
        startImeComposition,
        updateImeComposition,
        endImeComposition,
        pinImeOnKey,
        imeStyleObserver,
      };
      terminals.current.set(session.id, entry);
    }

    for (const [sessionId, terminalEntry] of terminals.current) {
      if (terminalEntry.element.parentElement !== host) host.appendChild(terminalEntry.element);
      applySessionLayout(terminalEntry.element);
      terminalEntry.element.hidden = sessionId !== session.id;
    }
    const selectedEntry = entry;
    const frame = requestAnimationFrame(() => {
      if (selectedSessionId.current !== session.id) return;
      selectedEntry.fitAddon.fit();
      window.piBridge.resizeSessionTui(session.id, selectedEntry.terminal.cols, selectedEntry.terminal.rows);
      selectedEntry.terminal.focus();
      publishDockChromeRef.current(selectedEntry.terminal);
    });
    return () => cancelAnimationFrame(frame);
  }, [session]);

  useEffect(() => {
    const host = terminalPane.current;
    if (!host) return;
    let frame = 0;
    const observer = new ResizeObserver(() => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const sessionId = selectedSessionId.current;
        if (!sessionId) return;
        const entry = terminals.current.get(sessionId);
        if (!entry || entry.element.hidden) return;
        entry.fitAddon.fit();
        window.piBridge.resizeSessionTui(sessionId, entry.terminal.cols, entry.terminal.rows);
        publishDockChromeRef.current(entry.terminal);
      });
    });
    observer.observe(host);
    return () => {
      observer.disconnect();
      cancelAnimationFrame(frame);
    };
  }, []);

  useEffect(() => {
    const host = root.current;
    if (!host) return;
    const onWheel = (event: WheelEvent) => {
      const sessionId = selectedSessionId.current;
      if (!sessionId || event.deltaY === 0) return;
      const entry = terminals.current.get(sessionId);
      if (!entry || entry.element.hidden) return;
      const screen = entry.terminal.element?.querySelector<HTMLElement>(".xterm-screen");
      if (!screen || entry.terminal.cols <= 0 || entry.terminal.rows <= 0) return;
      event.preventDefault();
      event.stopPropagation();
      const bounds = screen.getBoundingClientRect();
      if (bounds.width <= 0 || bounds.height <= 0) return;
      const cellWidth = bounds.width / entry.terminal.cols;
      const cellHeight = bounds.height / entry.terminal.rows;
      const col = Math.max(1, Math.min(entry.terminal.cols, Math.floor((event.clientX - bounds.left) / cellWidth) + 1));
      const row = Math.max(1, Math.min(entry.terminal.rows, Math.floor((event.clientY - bounds.top) / cellHeight) + 1));
      const button = event.deltaY < 0 ? 64 : 65;
      const lines = Math.max(1, Math.min(6, Math.round(Math.abs(event.deltaY) / Math.max(cellHeight, 16))));
      window.piBridge.writeSessionTui(sessionId, `\x1b[<${button};${col};${row}M`.repeat(lines));
    };
    host.addEventListener("wheel", onWheel, { capture: true, passive: false });
    return () => host.removeEventListener("wheel", onWheel, true);
  }, []);

  useEffect(() => {
    const terminalEntries = terminals.current;
    return () => {
      for (const entry of terminalEntries.values()) disposeTerminalEntry(entry);
      terminalEntries.clear();
      if (tuiWorkingRef.current.size > 0) {
        tuiWorkingRef.current = new Set();
        onTuiWorkingChangeRef.current?.(tuiWorkingRef.current);
      }
    };
  }, []);

  return (
    <div
      ref={root}
      className="embedded-pi-terminal"
      style={{
        position: "absolute",
        inset: 0,
        overflow: "hidden",
        background: "var(--bg)",
      }}
    >
      <div ref={terminalPane} style={{ position: "absolute", inset: 0, overflow: "hidden", zIndex: 0 }}>
        {!session && (
          <div
            style={{
              height: "100%",
              display: "grid",
              placeItems: "center",
              color: "var(--text-muted)",
              fontSize: 14,
            }}
          >
            Select a session to open Pi
          </div>
        )}
      </div>
      {session && coverOn && (
        <div
          style={{
            position: "absolute",
            left: 0,
            right: 0,
            bottom: 0,
            minHeight: COVER_MIN_ROWS * cellPx,
            display: "flex",
            overflow: "visible",
            background: "var(--bg-panel)",
            zIndex: 20,
            pointerEvents: "auto",
          }}
        >
          <TuiDockComposer
            theme={theme}
            cwd={session.cwd}
            sessionId={session.id}
            sessionPath={session.path}
            onRelocated={onSessionRelocated}
            chrome={dockChrome}
            worktreeAnchorRef={worktreeAnchorRef}
            onSend={(text) => window.piBridge.writeSessionTui(session.id, text + "\r")}
            onSelectModel={(provider, id) => window.piBridge.writeSessionTui(session.id, `/model ${provider}/${id}\r`)}
            onSelectThinking={(steps) => window.piBridge.writeSessionTui(session.id, "\u001b[Z".repeat(steps))}
            onHideCover={() => setCoverOn(false)}
          />
        </div>
      )}
      {session && !coverOn && (
        <button
          type="button"
          className="tui-dock-pill"
          style={{ position: "absolute", right: 12, bottom: 10, zIndex: 20 }}
          onClick={() => setCoverOn(true)}
        >
          卡片
        </button>
      )}
    </div>
  );
}
