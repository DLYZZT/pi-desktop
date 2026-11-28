import { useId, useLayoutEffect, useRef, useState } from "react";
import type { ExtensionDialogRequest } from "@shared/types";
import { useI18n } from "@/i18n";
import { scaledChatFont } from "@/lib/chat-appearance";
import { localizedExtensionConfirmCopy } from "@/lib/extension-ui-copy";

export function ExtensionDialog({
  request,
  onRespond,
  onStop,
}: {
  onStop?: () => void;
  request: ExtensionDialogRequest;
  onRespond: (
    request: ExtensionDialogRequest,
    response: { value: string } | { confirmed: boolean } | { cancelled: true },
  ) => void;
}) {
  const { t } = useI18n();
  const [value, setValue] = useState(request.method === "editor" ? (request.prefill ?? "") : "");
  const confirmCopy = request.method === "confirm" ? localizedExtensionConfirmCopy(request, t) : null;

  const panelRef = useRef<HTMLDivElement>(null);
  const titleId = useId();
  useLayoutEffect(() => {
    const panel = panelRef.current;
    if (!panel) return;
    const previous = document.activeElement;
    const initial = panel.querySelector<HTMLElement>("[data-initial-focus]") ?? panel;
    const overlay = panel.parentElement;
    const background = Array.from(overlay?.parentElement?.children ?? []).filter(
      (child): child is HTMLElement => child instanceof HTMLElement && child !== overlay && !child.inert,
    );
    initial.focus({ preventScroll: true });
    for (const child of background) child.inert = true;
    const keepChatFocus = (event: FocusEvent) => {
      const target = event.target;
      if (
        target instanceof HTMLElement &&
        panel.parentElement?.parentElement?.contains(target) &&
        !panel.contains(target)
      )
        initial.focus({ preventScroll: true });
    };
    document.addEventListener("focusin", keepChatFocus);
    return () => {
      document.removeEventListener("focusin", keepChatFocus);
      for (const child of background) child.inert = false;
      if (
        previous instanceof HTMLElement &&
        previous.isConnected &&
        (panel.contains(document.activeElement) || document.activeElement === document.body)
      )
        previous.focus({ preventScroll: true });
    };
  }, []);
  const submitValue = () => {
    if (request.method === "confirm") {
      onRespond(request, { confirmed: true });
    } else {
      onRespond(request, { value });
    }
  };

  return (
    <div
      style={{
        position: "absolute",
        inset: 0,
        zIndex: 90,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 20,
        background: "rgba(0,0,0,0.18)",
      }}
    >
      <div
        ref={panelRef}
        tabIndex={-1}
        aria-labelledby={titleId}
        onKeyDown={(event) => {
          event.stopPropagation();
          if (event.nativeEvent.isComposing) return;
          if (event.key === "Escape") {
            event.preventDefault();
            onRespond(request, { cancelled: true });
          } else if (event.key === "Tab") {
            const controls = Array.from(
              event.currentTarget.querySelectorAll<HTMLElement>("button:enabled, input:enabled, textarea:enabled"),
            );
            const next = controls.indexOf(document.activeElement as HTMLElement) + (event.shiftKey ? -1 : 1);
            event.preventDefault();
            controls[(next + controls.length) % controls.length]?.focus();
          }
        }}
        role="dialog"
        aria-modal="true"
        style={{
          width: "min(560px, 100%)",
          border: "1px solid var(--border)",
          borderRadius: 8,
          background: "var(--bg)",
          boxShadow: "0 20px 60px rgba(0,0,0,0.28)",
          overflow: "hidden",
        }}
      >
        <div style={{ padding: "12px 14px", borderBottom: "1px solid var(--border)" }}>
          <div id={titleId} style={{ color: "var(--text)", fontSize: scaledChatFont(14), fontWeight: 650 }}>
            {confirmCopy?.title ?? request.title}
          </div>
          <div
            style={{
              marginTop: 3,
              color: "var(--text-dim)",
              fontSize: scaledChatFont(11),
              fontFamily: "var(--font-mono)",
            }}
          >
            {request.method === "editor"
              ? t("extensionRequest", "Extension request")
              : (request.blockedKind ?? (request.method === "confirm" ? "permission" : "question")) === "permission"
                ? t("extensionDialogPermission", "Permission request")
                : request.blockedKind === "auth"
                  ? t("extensionDialogAuth", "Sign-in")
                  : t("extensionDialogQuestion", "Question")}
            {confirmCopy?.subtitle && <> · {confirmCopy.subtitle}</>}
          </div>
        </div>

        <div style={{ padding: 14, maxHeight: "55vh", overflowY: "auto" }}>
          {request.method === "confirm" && (
            <div
              style={{
                color: "var(--text-muted)",
                fontSize: scaledChatFont(13),
                lineHeight: 1.6,
                whiteSpace: "pre-wrap",
              }}
            >
              {confirmCopy?.message ?? request.message}
            </div>
          )}
          {request.method === "select" && (
            <div style={{ display: "grid", gap: 8 }}>
              {request.options.map((option) => (
                <button
                  key={option}
                  onClick={() => onRespond(request, { value: option })}
                  style={{
                    width: "100%",
                    padding: "9px 10px",
                    borderRadius: 7,
                    border: "1px solid var(--border)",
                    background: "var(--bg-panel)",
                    color: "var(--text)",
                    cursor: "pointer",
                    textAlign: "left",
                    fontSize: scaledChatFont(13),
                  }}
                >
                  {option}
                </button>
              ))}
            </div>
          )}
          {request.method === "input" && (
            <input
              data-initial-focus
              aria-labelledby={titleId}
              value={value}
              placeholder={request.placeholder}
              onChange={(e) => setValue(e.target.value)}
              onKeyDown={(e) => {
                if (!e.nativeEvent.isComposing && e.key === "Enter") submitValue();
              }}
              style={{
                width: "100%",
                padding: "9px 10px",
                borderRadius: 7,
                border: "1px solid var(--border)",
                background: "var(--bg-panel)",
                color: "var(--text)",
                outline: "none",
                fontSize: scaledChatFont(13),
              }}
            />
          )}
          {request.method === "editor" && (
            <textarea
              data-initial-focus
              aria-labelledby={titleId}
              value={value}
              onChange={(e) => setValue(e.target.value)}
              onKeyDown={(e) => {
                if (!e.nativeEvent.isComposing && (e.metaKey || e.ctrlKey) && e.key === "Enter") submitValue();
              }}
              style={{
                width: "100%",
                minHeight: 220,
                padding: 10,
                borderRadius: 7,
                border: "1px solid var(--border)",
                background: "var(--bg-panel)",
                color: "var(--text)",
                outline: "none",
                resize: "vertical",
                fontSize: scaledChatFont(13),
                lineHeight: 1.55,
                fontFamily: "var(--font-mono)",
              }}
            />
          )}
        </div>

        <div
          style={{
            display: "flex",
            justifyContent: "flex-end",
            gap: 8,
            padding: "10px 14px",
            borderTop: "1px solid var(--border)",
            background: "var(--bg-panel)",
          }}
        >
          {onStop && (
            <button type="button" style={{ marginRight: "auto" }} onClick={onStop}>
              {t("stopCurrentCommand", "Stop command")}
            </button>
          )}
          <button
            data-initial-focus={request.method === "confirm" || request.method === "select" ? true : undefined}
            onClick={() => onRespond(request, { cancelled: true })}
            style={{
              padding: "6px 10px",
              borderRadius: 6,
              border: "1px solid var(--border)",
              background: "var(--bg)",
              color: "var(--text-muted)",
              cursor: "pointer",
            }}
          >
            {t("cancel", "Cancel")}
          </button>
          {request.method === "confirm" ? (
            <button
              onClick={submitValue}
              style={{
                padding: "6px 10px",
                borderRadius: 6,
                border: "1px solid var(--accent)",
                background: "var(--accent)",
                color: "#fff",
                cursor: "pointer",
              }}
            >
              {confirmCopy?.confirmLabel ?? t("confirm", "Confirm")}
            </button>
          ) : request.method !== "select" ? (
            <button
              onClick={submitValue}
              style={{
                padding: "6px 10px",
                borderRadius: 6,
                border: "1px solid var(--accent)",
                background: "var(--accent)",
                color: "#fff",
                cursor: "pointer",
              }}
            >
              {t("submit", "Submit")}
            </button>
          ) : null}
        </div>
      </div>
    </div>
  );
}
