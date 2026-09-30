import { Fragment, useEffect, useRef, useState, type CSSProperties } from "react";
import type { ExtensionUiRequest } from "@/lib/types";
import { normalizeCustomPanelLines, parseAnsiLine } from "@/lib/ansi";
import { scaledChatFont } from "@/lib/chat-appearance";
import { useI18n } from "@/i18n";
import { customUiKey, customUiWheel } from "@/lib/custom-ui-input";
import { MAX_CUSTOM_UI_INPUT, type CustomUiInput } from "@shared/desktop-custom-ui";

type Request = Extract<ExtensionUiRequest, { method: "custom" }>;

/** A text-component compatibility panel, not a privileged webview or extension React runtime. */
export function ExtensionCustomPanel({
  request,
  onInput,
}: {
  request: Request;
  onInput: (request: Request, input: CustomUiInput) => void;
}) {
  const { t } = useI18n();
  const layerRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const preRef = useRef<HTMLPreElement>(null);
  const measureRef = useRef<HTMLSpanElement>(null);
  const composing = useRef(false);
  const [compositionOwner, setCompositionOwner] = useState<string | null>(null);
  const compositionVisible = compositionOwner === request.id;
  const [notice, setNotice] = useState("");
  const latest = useRef({ request, onInput });
  latest.current = { request, onInput };
  const send = (input: CustomUiInput) => latest.current.onInput(latest.current.request, input);
  const lines = normalizeCustomPanelLines(request.lines.map((line) => line.replace(/├(─+)┤/, "─$1─")));
  const fontSize = scaledChatFont(13);

  useEffect(() => {
    const prior = document.activeElement;
    const input = inputRef.current;
    if (input) {
      input.value = "";
      input.focus();
    }
    return () => {
      composing.current = false;
      if (input) input.value = "";
      if (prior instanceof HTMLElement && prior.isConnected) prior.focus();
    };
  }, [request.id]);

  useEffect(() => {
    const layer = layerRef.current,
      measure = measureRef.current;
    if (!layer || !measure) return;
    let last = "";
    const resize = () => {
      const charWidth = measure.getBoundingClientRect().width / 32;
      const rowHeight = Number.parseFloat(getComputedStyle(measure).lineHeight);
      if (!charWidth || !rowHeight) return;
      const columns = Math.max(16, Math.min(240, Math.floor((Math.min(920, layer.clientWidth - 40) - 30) / charWidth)));
      const rows = Math.max(8, Math.min(100, Math.floor((layer.clientHeight - 120) / rowHeight)));
      const next = `${columns}:${rows}`;
      if (next === last) return;
      last = next;
      latest.current.onInput(latest.current.request, { kind: "resize", columns, rows });
    };
    const observer = new ResizeObserver(resize);
    observer.observe(layer);
    observer.observe(measure);
    resize();
    const onWindowResize = () => resize();
    window.addEventListener("resize", onWindowResize);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", onWindowResize);
    };
  }, [request.id, fontSize]);

  useEffect(() => {
    const element = preRef.current;
    if (!element) return;
    let delta = 0;
    let frame: ReturnType<typeof setTimeout> | undefined;
    const wheel = (event: WheelEvent) => {
      if (element.scrollHeight > element.clientHeight + 1) return;
      if (event.ctrlKey || !event.deltaY || Math.abs(event.deltaX) > Math.abs(event.deltaY)) return;
      event.preventDefault();
      event.stopPropagation();
      delta += event.deltaY;
      if (frame) return;
      frame = setTimeout(() => {
        frame = undefined;
        const data = customUiWheel(delta);
        delta = 0;
        if (data) latest.current.onInput(latest.current.request, data);
      }, 16);
    };
    element.addEventListener("wheel", wheel, { passive: false });
    return () => {
      element.removeEventListener("wheel", wheel);
      if (frame) clearTimeout(frame);
    };
  }, [request.id]);

  const flushText = () => {
    const input = inputRef.current;
    if (!input || composing.current) return;
    const text = input.value;
    input.value = "";
    if (text) send(text);
  };

  return (
    <div
      ref={layerRef}
      style={{
        position: "absolute",
        inset: 0,
        zIndex: 95,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 20,
        background: "rgba(0,0,0,0.18)",
      }}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={t("extensionRequest", "Extension request")}
        onKeyDown={(event) => {
          // The hidden textarea handles TUI keys. Keep keyboard focus inside the modal's native controls.
          if (event.target !== inputRef.current && event.key === "Tab") {
            event.preventDefault();
            inputRef.current?.focus();
          }
          if (event.target !== inputRef.current && event.key === "Escape") {
            event.preventDefault();
            send({ kind: "close" });
          }
          event.stopPropagation();
        }}
        style={{
          position: "relative",
          display: "flex",
          flexDirection: "column",
          width: "fit-content",
          maxWidth: "min(920px,100%)",
          maxHeight: "100%",
          border: "1px solid var(--border)",
          borderRadius: 8,
          background: "var(--bg)",
          boxShadow: "0 20px 60px rgba(0,0,0,0.28)",
          overflow: "hidden",
        }}
      >
        <div
          style={{
            display: "flex",
            flexShrink: 0,
            alignItems: "center",
            justifyContent: "space-between",
            gap: 12,
            padding: "10px 12px",
            borderBottom: "1px solid var(--border)",
          }}
        >
          <div style={{ color: "var(--text)", fontSize: scaledChatFont(13), fontWeight: 650 }}>
            {t("extensionRequest", "Extension request")}
          </div>
          <button
            onClick={() => send({ kind: "close" })}
            style={{
              padding: "5px 9px",
              borderRadius: 6,
              border: "1px solid var(--border)",
              background: "var(--bg-panel)",
              color: "var(--text-muted)",
              cursor: "pointer",
            }}
          >
            {t("close", "Close")}
          </button>
        </div>
        <span
          ref={measureRef}
          aria-hidden="true"
          style={{
            position: "absolute",
            visibility: "hidden",
            width: "max-content",
            whiteSpace: "pre",
            fontFamily: "var(--font-mono)",
            fontSize,
            lineHeight: 1.45,
          }}
        >
          {"M".repeat(32)}
        </span>
        <textarea
          ref={inputRef}
          aria-describedby={`extension-content-${request.id}`}
          aria-label={t("extensionRequest", "Extension request")}
          autoCapitalize="off"
          autoComplete="off"
          spellCheck={false}
          style={
            compositionVisible
              ? {
                  order: 1,
                  flexShrink: 0,
                  margin: "0 14px 12px",
                  width: "calc(100% - 28px)",
                  height: 64,
                  resize: "none",
                  padding: "10px 12px",
                  boxSizing: "border-box",
                  background: "var(--bg)",
                  color: "var(--text)",
                  border: "2px solid var(--text-muted)",
                  borderRadius: 6,
                  fontFamily: "var(--font-mono)",
                  fontSize,
                  lineHeight: 1.45,
                }
              : { position: "absolute", width: 1, height: 1, opacity: 0, resize: "none" }
          }
          onKeyDown={(event) => {
            // Let native paste and selection-copy produce browser events rather than Ctrl+V/C.
            if (event.key === "Escape" && (event.ctrlKey || event.metaKey)) {
              event.preventDefault();
              send({ kind: "close" });
              return;
            }
            if (event.key === "Tab" && event.shiftKey && !composing.current) {
              event.preventDefault();
              panelRef.current?.querySelector("button")?.focus();
              return;
            }
            const key = event.key.toLowerCase();
            if ((event.ctrlKey || event.metaKey) && key === "v") return;
            if ((event.ctrlKey || event.metaKey) && key === "c" && !window.getSelection()?.isCollapsed) return;
            const data = customUiKey({
              key: event.key,
              ctrlKey: event.ctrlKey,
              altKey: event.altKey,
              shiftKey: event.shiftKey,
              metaKey: event.metaKey,
              isComposing: composing.current || event.nativeEvent.isComposing,
              getModifierState: (modifier) => event.getModifierState(modifier),
            });
            if (data === null) return;
            event.preventDefault();
            event.stopPropagation();
            send(data);
          }}
          onInput={() => {
            if (!composing.current) flushText();
          }}
          onCompositionStart={() => {
            composing.current = true;
            setCompositionOwner(request.id);
          }}
          onCompositionEnd={() => {
            composing.current = false;
            setCompositionOwner(null);
            // input may follow compositionend. Whichever runs first drains the buffer; no duplicate commit.
            const ownerId = request.id;
            queueMicrotask(() => {
              if (latest.current.request.id === ownerId) flushText();
            });
          }}
          onPaste={(event) => {
            event.preventDefault();
            event.stopPropagation();
            const text = event.clipboardData.getData("text/plain");
            if (text.length > MAX_CUSTOM_UI_INPUT) {
              setNotice(t("extensionPasteLimit", "Paste is limited to 100,000 characters in extension panels."));
              return;
            }
            setNotice("");
            if (text) send({ kind: "paste", text });
          }}
        />
        <pre
          ref={preRef}
          id={`extension-content-${request.id}`}
          onClick={() => {
            if (window.getSelection()?.isCollapsed !== false) inputRef.current?.focus();
          }}
          style={{
            margin: 0,
            padding: 14,
            flex: "1 1 auto",
            minHeight: 0,
            maxHeight: "calc(100vh - 130px)",
            overflow: "auto",
            // Terminal ANSI colors use a stable dark canvas, independent of app chrome.
            background: "#1c1917",
            color: "#fafaf9",
            ...({ "--text": "#fafaf9", "--bg-panel": "#1c1917" } as CSSProperties),
            colorScheme: "dark",
            fontFamily: "var(--font-mono)",
            fontSize,
            lineHeight: 1.45,
            whiteSpace: "pre",
          }}
        >
          {(lines.length ? lines : [""]).map((line, index, all) => (
            <Fragment key={index}>
              {parseAnsiLine(line).map((segment, part) => (
                <span key={part} style={segment.style}>
                  {segment.text}
                </span>
              ))}
              {index < all.length - 1 ? "\n" : null}
            </Fragment>
          ))}
        </pre>
        {notice && (
          <div role="status" style={{ flexShrink: 0, padding: "8px 12px", color: "var(--text-muted)" }}>
            {notice}
          </div>
        )}
      </div>
    </div>
  );
}
