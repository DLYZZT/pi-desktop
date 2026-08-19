import type { CSSProperties, MouseEvent, ReactNode } from "react";
import type { SessionInfo } from "@/lib/types";
import { sessionProjectLabel } from "./sessions";

export function ForkProjectPickerLabel({ scopedLabel, allLabel }: { scopedLabel?: string | null; allLabel: string }) {
  if (scopedLabel) {
    return (
      <span
        style={{
          flex: 1,
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
          fontFamily: "var(--font-mono)",
          fontSize: 11,
          color: "var(--text)",
          direction: "rtl",
          textAlign: "left",
        }}
      >
        <span style={{ unicodeBidi: "plaintext" }}>{scopedLabel}</span>
      </span>
    );
  }
  return (
    <span
      style={{
        flex: 1,
        overflow: "hidden",
        textOverflow: "ellipsis",
        whiteSpace: "nowrap",
        fontFamily: "var(--font-mono)",
        fontSize: 11,
        color: "var(--text)",
      }}
    >
      {allLabel}
    </span>
  );
}

export function ForkAllProjectsOption({
  selected,
  label,
  onSelect,
}: {
  selected: boolean;
  label: string;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 7,
        width: "100%",
        padding: "8px 10px",
        background: "var(--bg)",
        border: "none",
        borderBottom: "1px solid var(--border)",
        color: selected ? "var(--text)" : "var(--text-muted)",
        cursor: "pointer",
        textAlign: "left",
        fontSize: 11,
        fontFamily: "var(--font-mono)",
      }}
    >
      {selected ? (
        <svg
          width="10"
          height="10"
          viewBox="0 0 10 10"
          fill="none"
          stroke="var(--accent)"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          style={{ flexShrink: 0 }}
        >
          <polyline points="1.5 5 4 7.5 8.5 2.5" />
        </svg>
      ) : (
        <span style={{ width: 10, flexShrink: 0 }} />
      )}
      {label}
    </button>
  );
}

export function ForkProjectTag({ session }: { session: SessionInfo }) {
  const label = sessionProjectLabel(session);
  if (!label) return null;
  return (
    <span
      title={session.projectRoot ?? session.cwd}
      style={{
        overflow: "hidden",
        textOverflow: "ellipsis",
        whiteSpace: "nowrap",
        fontFamily: "var(--font-mono)",
        fontSize: 11,
        color: "var(--text-muted)",
      }}
    >
      {label}
    </span>
  );
}

export function ForkArchiveMenuItem({
  archived,
  archiveLabel,
  unarchiveLabel,
  style,
  onClick,
}: {
  archived?: boolean;
  archiveLabel: string;
  unarchiveLabel: string;
  style: CSSProperties;
  onClick: (event: MouseEvent<HTMLButtonElement>) => void;
}) {
  return (
    <button type="button" role="menuitem" className="session-menu-item" onClick={onClick} style={style}>
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
        <polyline points="21 8 21 21 3 21 3 8" />
        <rect x="1" y="3" width="22" height="5" />
        <line x1="10" y1="12" x2="14" y2="12" />
      </svg>
      {archived ? unarchiveLabel : archiveLabel}
    </button>
  );
}

export function ForkArchivedDrawer({
  open,
  count,
  title,
  countLabel,
  emptyLabel,
  onToggle,
  children,
}: {
  open: boolean;
  count: number;
  title: string;
  countLabel: string;
  emptyLabel: string;
  onToggle: () => void;
  children: ReactNode;
}) {
  return (
    <div style={{ flexShrink: 0, borderTop: "1px solid var(--border)" }}>
      <button
        type="button"
        onClick={onToggle}
        style={{
          width: "100%",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 8,
          padding: "8px 14px",
          background: open ? "var(--bg-hover)" : "transparent",
          border: "none",
          color: "var(--text-muted)",
          cursor: "pointer",
          fontSize: 12,
          fontFamily: "var(--font-mono)",
        }}
      >
        <span>{title}</span>
        <span>{countLabel}</span>
      </button>
      {open && (
        <div style={{ maxHeight: 220, overflowY: "auto", padding: "0 6px 8px" }}>
          {count === 0 ? (
            <div style={{ padding: "8px 8px 4px", color: "var(--text-dim)", fontSize: 12 }}>{emptyLabel}</div>
          ) : (
            children
          )}
        </div>
      )}
    </div>
  );
}

export function ForkGroupByProjectToggle({
  enabled,
  onLabel,
  offLabel,
  onToggle,
}: {
  enabled: boolean;
  onLabel: string;
  offLabel: string;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      title={enabled ? offLabel : onLabel}
      aria-pressed={enabled}
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        width: 28,
        height: 28,
        padding: 0,
        border: enabled ? "1px solid var(--accent-soft-border)" : "1px solid transparent",
        borderRadius: 6,
        background: enabled ? "var(--bg-selected)" : "transparent",
        color: enabled ? "var(--accent)" : "var(--text-dim)",
        cursor: "pointer",
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
        <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
      </svg>
    </button>
  );
}

export function ForkProjectFolder({
  label,
  count,
  collapsed,
  newSessionLabel,
  onToggle,
  onNewSession,
  children,
}: {
  label: string;
  count: number;
  collapsed: boolean;
  newSessionLabel: string;
  onToggle: () => void;
  onNewSession: () => void;
  children: ReactNode;
}) {
  return (
    <section>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 2,
          padding: "3px 4px 3px 8px",
        }}
      >
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={!collapsed}
          style={{
            flex: 1,
            minWidth: 0,
            display: "flex",
            alignItems: "center",
            gap: 6,
            padding: "4px 4px",
            border: "none",
            background: "transparent",
            color: "var(--text-dim)",
            cursor: "pointer",
            fontSize: 12,
            fontWeight: 650,
            textAlign: "left",
          }}
        >
          <svg
            width="10"
            height="10"
            viewBox="0 0 10 10"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
            style={{ transform: collapsed ? "rotate(-90deg)" : "none", transition: "transform 0.15s" }}
          >
            <polyline points="2 3.5 5 6.5 8 3.5" />
          </svg>
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
            <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
          </svg>
          <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1 }}>{label}</span>
          <span style={{ fontFamily: "var(--font-mono)", fontWeight: 500 }}>{count}</span>
        </button>
        <button
          type="button"
          title={newSessionLabel}
          aria-label={newSessionLabel}
          onClick={(event) => {
            event.stopPropagation();
            onNewSession();
          }}
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            width: 24,
            height: 24,
            padding: 0,
            flexShrink: 0,
            border: "none",
            borderRadius: 6,
            background: "transparent",
            color: "var(--text-dim)",
            cursor: "pointer",
          }}
        >
          <span style={{ fontSize: 16, lineHeight: 1 }}>+</span>
        </button>
      </div>
      {!collapsed && <div role="list">{children}</div>}
    </section>
  );
}
