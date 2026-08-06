import { useEffect, useRef, type CSSProperties } from "react";
import { useI18n } from "@/i18n";
import type { BrowserAgentAuthorizationDecision, BrowserAgentAuthorizationRequest } from "../../../contract/browser";

export function BrowserAuthorizationDialog({
  request,
  sessionTitle,
  onRespond,
  onManage,
}: {
  request: BrowserAgentAuthorizationRequest;
  sessionTitle: string;
  onRespond: (decision: BrowserAgentAuthorizationDecision) => void;
  onManage: () => void;
}) {
  const { t } = useI18n();
  const dialogRef = useRef<HTMLDivElement>(null);
  const denyRef = useRef<HTMLButtonElement>(null);
  const returnFocusRef = useRef<HTMLElement | null>(
    document.activeElement instanceof HTMLElement ? document.activeElement : null,
  );

  useEffect(() => {
    denyRef.current?.focus();
    const returnFocus = returnFocusRef.current;
    return () => returnFocus?.focus();
  }, []);

  const permissionLabel =
    request.minimumPermission === "read"
      ? t("browserAuthorizationRead", "Read pages")
      : request.minimumPermission === "interact"
        ? t("browserAuthorizationInteract", "Interact with pages")
        : t("browserAuthorizationAdvanced", "Use Advanced Browser Mode");
  const capability =
    request.minimumPermission === "read"
      ? t(
          "browserAuthorizationReadSummary",
          "The Agent can open pages, navigate, read page snapshots, and take screenshots.",
        )
      : request.minimumPermission === "interact"
        ? t(
            "browserAuthorizationInteractSummary",
            "The Agent can also click, type, press keys, and scroll in Browser tabs owned by this session.",
          )
        : t(
            "browserAuthorizationAdvancedSummary",
            "The Agent can also execute JavaScript, inspect captured network data, replay requests, and use CDP.",
          );

  return (
    <div
      role="presentation"
      onClick={(event) => {
        if (event.target === event.currentTarget) onRespond("deny");
      }}
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 1200,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 20,
        background: "rgba(0,0,0,0.5)",
      }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="browser-agent-authorization-title"
        aria-describedby="browser-agent-authorization-description"
        onKeyDown={(event) => {
          event.stopPropagation();
          if (event.key === "Escape") {
            event.preventDefault();
            onRespond("deny");
            return;
          }
          if (event.key !== "Tab") return;
          const dialog = dialogRef.current;
          if (!dialog) return;
          const focusable = Array.from(
            dialog.querySelectorAll<HTMLElement>('button:not([disabled]), [tabindex]:not([tabindex="-1"])'),
          );
          const first = focusable[0];
          const last = focusable[focusable.length - 1];
          if (!first || !last) return;
          if (event.shiftKey && document.activeElement === first) {
            event.preventDefault();
            last.focus();
          } else if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault();
            first.focus();
          }
        }}
        style={{
          width: "min(520px, 100%)",
          maxHeight: "min(680px, calc(100dvh - 40px))",
          overflowY: "auto",
          display: "grid",
          gap: 16,
          padding: "22px",
          border: "1px solid var(--border)",
          borderRadius: 12,
          background: "var(--bg-panel)",
          boxShadow: "0 24px 80px rgba(0,0,0,0.35)",
        }}
      >
        <div>
          <h2 id="browser-agent-authorization-title" style={{ margin: 0, fontSize: 18 }}>
            {t("browserAuthorizationTitle", "Allow Agent Browser access?")}
          </h2>
          <p
            id="browser-agent-authorization-description"
            style={{ margin: "8px 0 0", color: "var(--text-muted)", fontSize: 13, lineHeight: 1.55 }}
          >
            {t(
              "browserAuthorizationDescription",
              "Pi Desktop paused the Browser tool before it made any page, network, or input changes.",
            )}
          </p>
        </div>
        <dl
          style={{
            margin: 0,
            display: "grid",
            gridTemplateColumns: "minmax(90px, auto) minmax(0, 1fr)",
            gap: "8px 14px",
            fontSize: 13,
          }}
        >
          <dt style={{ color: "var(--text-muted)" }}>{t("browserAuthorizationSession", "Session")}</dt>
          <dd style={{ margin: 0, overflowWrap: "anywhere" }}>{sessionTitle}</dd>
          <dt style={{ color: "var(--text-muted)" }}>{t("browserAuthorizationSource", "Source")}</dt>
          <dd style={{ margin: 0 }}>
            {request.source === "channel"
              ? t("browserAuthorizationSourceChannel", "Approved messaging channel")
              : t("browserAuthorizationSourceLocal", "Local desktop session")}
          </dd>
          <dt style={{ color: "var(--text-muted)" }}>{t("browserAuthorizationPermission", "Permission")}</dt>
          <dd style={{ margin: 0 }}>{permissionLabel}</dd>
        </dl>
        <div
          style={{
            padding: 12,
            borderRadius: 8,
            background: "color-mix(in srgb, var(--accent) 8%, var(--bg))",
            fontSize: 13,
            lineHeight: 1.55,
          }}
        >
          {capability}
        </div>
        <div style={{ color: "var(--text-muted)", fontSize: 12, lineHeight: 1.55 }}>
          {t(
            "browserAuthorizationSessionOnly",
            "Allowing here lasts only for this running Agent session. Permanent permissions can only be saved in Browser settings.",
          )}
        </div>
        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", flexWrap: "wrap" }}>
          <button type="button" onClick={onManage} style={buttonStyle}>
            {t("browserAuthorizationManage", "Manage permanent permission…")}
          </button>
          <button ref={denyRef} type="button" onClick={() => onRespond("deny")} style={buttonStyle}>
            {t("browserDeny", "Deny")}
          </button>
          <button type="button" onClick={() => onRespond("allow-session")} style={primaryButtonStyle}>
            {t("browserAllowCurrentAgentSession", "Allow current Agent session")}
          </button>
        </div>
      </div>
    </div>
  );
}

const buttonStyle: CSSProperties = {
  minHeight: 34,
  padding: "0 12px",
  border: "1px solid var(--border)",
  borderRadius: 6,
  background: "var(--bg)",
  color: "var(--text)",
  cursor: "pointer",
};

const primaryButtonStyle: CSSProperties = {
  ...buttonStyle,
  borderColor: "var(--accent)",
  background: "var(--accent)",
  color: "white",
};
