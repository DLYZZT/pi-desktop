import { useEffect, useRef } from "react";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { Terminal } from "@xterm/xterm";
import { copyText } from "@/lib/clipboard";
import "@xterm/xterm/css/xterm.css";

type TerminalSession = {
  id: string;
  cwd: string;
};

type TerminalEntry = {
  cwd: string;
  terminal: Terminal;
  fitAddon: FitAddon;
  element: HTMLDivElement;
  inputDisposable: { dispose: () => void };
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

export function EmbeddedPiTerminal({ session, theme }: { session: TerminalSession | null; theme: "light" | "dark" }) {
  const root = useRef<HTMLDivElement | null>(null);
  const terminals = useRef(new Map<string, TerminalEntry>());
  const selectedSessionId = useRef<string | null>(session?.id ?? null);

  useEffect(() => {
    return window.piBridge.onSessionTuiData((payload) => {
      terminals.current.get(payload.sessionId)?.terminal.write(payload.data);
    });
  }, []);

  useEffect(() => {
    for (const entry of terminals.current.values()) {
      entry.terminal.options.theme = terminalTheme();
    }
  }, [theme]);

  useEffect(() => {
    selectedSessionId.current = session?.id ?? null;
    const host = root.current;
    if (!host || !session) return;

    let entry = terminals.current.get(session.id);
    if (entry && entry.cwd !== session.cwd) {
      disposeTerminalEntry(entry);
      terminals.current.delete(session.id);
      entry = undefined;
    }
    if (!entry) {
      const element = document.createElement("div");
      element.className = "embedded-pi-terminal-session";
      element.setAttribute("aria-label", `Pi terminal ${session.id}`);
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
      const inputDisposable = terminal.onData((data) => {
        window.piBridge.writeSessionTui(session.id, data);
      });
      entry = {
        cwd: session.cwd,
        terminal,
        fitAddon,
        element,
        inputDisposable,
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
      terminalEntry.element.hidden = sessionId !== session.id;
    }
    const selectedEntry = entry;
    const frame = requestAnimationFrame(() => {
      if (selectedSessionId.current !== session.id) return;
      selectedEntry.fitAddon.fit();
      window.piBridge.resizeSessionTui(session.id, selectedEntry.terminal.cols, selectedEntry.terminal.rows);
      selectedEntry.terminal.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [session]);

  useEffect(() => {
    const host = root.current;
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
      });
    });
    observer.observe(host);
    return () => {
      observer.disconnect();
      cancelAnimationFrame(frame);
    };
  }, []);

  useEffect(() => {
    const terminalEntries = terminals.current;
    return () => {
      for (const entry of terminalEntries.values()) disposeTerminalEntry(entry);
      terminalEntries.clear();
    };
  }, []);

  return (
    <div
      ref={root}
      className="embedded-pi-terminal"
      style={{ position: "absolute", inset: 0, overflow: "hidden", background: "var(--bg)" }}
    >
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
  );
}
