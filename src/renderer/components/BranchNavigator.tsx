import { useState, useCallback, useMemo, useRef, useEffect } from "react";
import type { SessionTreeEntry, SessionTreeNode } from "@/lib/types";
import {
  buildActivePath,
  compressBranchNode,
  flattenBranchTree,
  shouldDismissBranchNavigator,
  treeHasBranch,
  type BranchTreeRow,
} from "@/lib/branch-navigator-model";
import { useI18n } from "@/i18n";
import { formatNumber } from "@/lib/locale-format";

interface Props {
  tree: SessionTreeNode[];
  activeLeafId: string | null;
  onLeafChange: (leafId: string | null) => void;
  /** When true, renders as a compact inline button for embedding in a top bar */
  inline?: boolean;
  /** When inline, use this ref's bounding rect to size/position the dropdown */
  containerRef?: React.RefObject<HTMLElement | null>;
  /** Controlled open state for inline mode */
  open?: boolean;
  /** Called when the button is clicked in inline mode */
  onToggle?: () => void;
  /** Whether a session is currently active (used to show appropriate empty reason) */
  hasSession?: boolean;
  /** When inline, render icon-only (no text label) to save horizontal space */
  compact?: boolean;
}

function getLabel(entry: SessionTreeEntry, t: (key: string, fallback: string) => string): string {
  if (entry.preview) return entry.preview.length > 40 ? `${entry.preview.slice(0, 40)}…` : entry.preview;
  if (entry.role === "assistant") return t("assistantBranch", "[assistant]");
  return entry.type;
}

interface BranchTreeRowProps {
  row: BranchTreeRow;
  activePathIds: Set<string>;
  onSelect: (id: string) => void;
}

function BranchTreeRowView({ row, activePathIds, onSelect }: BranchTreeRowProps) {
  const { language, t } = useI18n();
  const rep = row.representative;
  const isActive = activePathIds.has(rep.entry.id);
  const isOnPath = activePathIds.has(row.node.entry.id) || activePathIds.has(rep.entry.id);
  const label = getLabel(rep.entry, t);
  const role = rep.entry.role ?? null;

  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        height: 24,
        cursor: "pointer",
      }}
      onClick={() => onSelect(rep.entry.id)}
    >
      {/* Indent guide lines are capped so pathological depth has bounded per-row work. */}
      {row.guideLines.map((hasLine, index) => (
        <div
          key={index}
          style={{
            width: 16,
            flexShrink: 0,
            position: "relative",
            height: "100%",
            alignSelf: "stretch",
          }}
        >
          {hasLine && (
            <div
              style={{
                position: "absolute",
                left: 7,
                top: 0,
                bottom: 0,
                width: 1,
                background: "var(--border)",
              }}
            />
          )}
        </div>
      ))}

      {row.depth > row.guideLines.length && (
        <div
          title={t("branchDepth", "Branch depth {depth}").replace("{depth}", formatNumber(row.depth + 1, language))}
          style={{ width: 16, flexShrink: 0, color: "var(--text-dim)", fontSize: 10, textAlign: "center" }}
        >
          …
        </div>
      )}

      {/* Branch connector */}
      <div style={{ width: 16, flexShrink: 0, position: "relative", height: "100%", alignSelf: "stretch" }}>
        {/* vertical line up (to parent) */}
        <div
          style={{
            position: "absolute",
            left: 7,
            top: 0,
            bottom: row.isLast ? "50%" : 0,
            width: 1,
            background: "var(--border)",
          }}
        />
        {/* horizontal line to node */}
        <div
          style={{
            position: "absolute",
            left: 7,
            top: "50%",
            width: 9,
            height: 1,
            background: "var(--border)",
          }}
        />
      </div>

      {/* Node dot */}
      <div
        style={{
          width: 7,
          height: 7,
          borderRadius: "50%",
          flexShrink: 0,
          background: isActive ? "var(--accent)" : isOnPath ? "var(--text-muted)" : "var(--border)",
          border: isActive ? "none" : "1px solid var(--text-dim)",
          marginRight: 6,
          transition: "background 0.12s",
        }}
      />

      {/* Role badge */}
      {role && (
        <span
          style={{
            fontSize: 9,
            fontFamily: "var(--font-mono)",
            color: role === "user" ? "var(--accent)" : "var(--text-dim)",
            background: role === "user" ? "var(--accent-soft)" : "var(--bg-hover)",
            border: `1px solid ${role === "user" ? "var(--accent-soft-border)" : "var(--border)"}`,
            borderRadius: 3,
            padding: "0 4px",
            marginRight: 5,
            flexShrink: 0,
            lineHeight: "16px",
          }}
        >
          {role === "user" ? "U" : "A"}
        </span>
      )}

      {/* Skipped indicator */}
      {row.skipped > 0 && (
        <span style={{ fontSize: 10, color: "var(--text-dim)", marginRight: 5, flexShrink: 0 }}>+{row.skipped}</span>
      )}

      {/* Label */}
      <span
        style={{
          fontSize: 11,
          color: isActive ? "var(--text)" : isOnPath ? "var(--text-muted)" : "var(--text-dim)",
          fontWeight: isActive ? 500 : 400,
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
          flex: 1,
          minWidth: 0,
        }}
      >
        {label}
      </span>
    </div>
  );
}

function BranchTreeRows({
  rows,
  activePathIds,
  onSelect,
}: {
  rows: BranchTreeRow[];
  activePathIds: Set<string>;
  onSelect: (id: string) => void;
}) {
  return rows.map((row) => (
    <BranchTreeRowView key={row.key} row={row} activePathIds={activePathIds} onSelect={onSelect} />
  ));
}

export function BranchNavigator({
  tree,
  activeLeafId,
  onLeafChange,
  inline,
  containerRef,
  open: openProp,
  onToggle,
  hasSession,
  compact,
}: Props) {
  const { t } = useI18n();
  const [openInternal, setOpenInternal] = useState(false);
  const open = openProp !== undefined ? openProp : openInternal;
  const rootRef = useRef<HTMLDivElement>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const [dropdownPos, setDropdownPos] = useState<{ top: number; left: number; width: number } | null>(null);

  const handleInlineToggle = useCallback(() => {
    if (onToggle) onToggle();
    else setOpenInternal((value) => !value);
  }, [onToggle]);

  const closeInline = useCallback(() => {
    if (!open) return;
    if (openProp !== undefined) onToggle?.();
    else setOpenInternal(false);
  }, [onToggle, open, openProp]);

  useEffect(() => {
    if (!open || !inline) return;
    const anchor = containerRef?.current ?? btnRef.current;
    if (!anchor) return;
    const update = () => {
      const rect = anchor.getBoundingClientRect();
      setDropdownPos({ top: rect.bottom, left: rect.left, width: rect.width });
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(anchor);
    return () => ro.disconnect();
  }, [open, inline, containerRef]);

  useEffect(() => {
    if (!open || !inline) return;
    const root = rootRef.current;
    if (!root) return;
    const handleDismiss = (event: Event) => {
      if (shouldDismissBranchNavigator(event, root)) closeInline();
    };
    document.addEventListener("keydown", handleDismiss);
    document.addEventListener("pointerdown", handleDismiss, true);
    return () => {
      document.removeEventListener("keydown", handleDismiss);
      document.removeEventListener("pointerdown", handleDismiss, true);
    };
  }, [closeInline, inline, open]);

  const activePathIds = useMemo(() => buildActivePath(tree, activeLeafId), [tree, activeLeafId]);
  const branchModel = useMemo(() => {
    const firstNode = tree.length > 0 ? compressBranchNode(tree[0]).node : null;
    return {
      hasBranch: treeHasBranch(tree),
      firstNode,
      rows: firstNode ? flattenBranchTree(firstNode.children) : [],
    };
  }, [tree]);

  const handleSelect = useCallback(
    (id: string) => {
      onLeafChange(id);
    },
    [onLeafChange],
  );

  const { firstNode, rows } = branchModel;
  const noBranchReason = !hasSession
    ? t("noActiveSession", "No active session")
    : !branchModel.hasBranch
      ? t("sessionHasNoBranches", "This session has no branches")
      : null;
  const hasContent = !noBranchReason && firstNode && firstNode.children.length > 1;

  const branchIcon = (
    <svg
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      style={{ color: hasContent ? "var(--accent)" : "var(--text-dim)", flexShrink: 0 }}
    >
      <line x1="6" y1="3" x2="6" y2="15" />
      <circle cx="18" cy="6" r="3" />
      <circle cx="6" cy="18" r="3" />
      <path d="M18 9a9 9 0 0 1-9 9" />
    </svg>
  );

  const chevron = (
    <svg
      width="10"
      height="10"
      viewBox="0 0 10 10"
      fill="none"
      stroke="var(--text-dim)"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      style={{ marginLeft: 2, transform: open ? "rotate(180deg)" : "none", transition: "transform 0.15s" }}
    >
      <polyline points="2 3.5 5 6.5 8 3.5" />
    </svg>
  );

  if (inline) {
    return (
      <div ref={rootRef} style={{ height: "100%", display: "flex", alignItems: "stretch" }}>
        <button
          ref={btnRef}
          onClick={handleInlineToggle}
          style={{
            display: "flex",
            alignItems: "center",
            gap: 6,
            height: "100%",
            padding: "0 12px",
            background: open ? "var(--bg-selected)" : "none",
            border: "none",
            borderTop: open ? "2px solid var(--accent)" : "2px solid transparent",
            borderRight: "1px solid var(--border)",
            cursor: "pointer",
            color: open ? "var(--text)" : "var(--text-muted)",
            fontSize: 11,
            whiteSpace: "nowrap",
            transition: "color 0.1s, background 0.1s",
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.color = "var(--text)";
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.color = open ? "var(--text)" : "var(--text-muted)";
          }}
          title={t("branches", "Branches")}
          aria-label={t("branches", "Branches")}
          aria-pressed={open}
        >
          {branchIcon}
          {!compact && <span>{t("branches", "Branches")}</span>}
        </button>
        {open && dropdownPos && (
          <div
            style={{
              position: "fixed",
              top: dropdownPos.top,
              left: dropdownPos.left,
              width: dropdownPos.width,
              background: "var(--bg-panel)",
              borderBottom: "1px solid var(--border)",
              zIndex: 500,
            }}
          >
            {hasContent && firstNode ? (
              <div style={{ padding: "4px 12px 8px 12px", maxHeight: 260, overflowY: "auto" }}>
                <BranchTreeRows rows={rows} activePathIds={activePathIds} onSelect={handleSelect} />
              </div>
            ) : (
              <div style={{ padding: "10px 16px", fontSize: 12, color: "var(--text-muted)", fontStyle: "italic" }}>
                {noBranchReason}
              </div>
            )}
          </div>
        )}
      </div>
    );
  }

  return (
    <div
      style={{ borderBottom: "1px solid var(--border)", background: "var(--bg)", flexShrink: 0, position: "relative" }}
    >
      {/* Header toggle */}
      <button
        onClick={() => setOpenInternal((v) => !v)}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
          width: "100%",
          padding: "5px 12px",
          background: "none",
          border: "none",
          cursor: "pointer",
          color: "var(--text-muted)",
          fontSize: 11,
          textAlign: "left",
        }}
      >
        {branchIcon}
        <span style={{ color: "var(--text-muted)" }}>{t("branches", "Branches")}</span>
        {chevron}
      </button>

      {/* Tree panel - overlay */}
      {open && (
        <div
          style={{
            position: "absolute",
            top: "100%",
            left: 0,
            right: 0,
            background: "var(--bg)",
            borderBottom: "1px solid var(--border)",
            boxShadow: "0 4px 12px rgba(0,0,0,0.1)",
            zIndex: 100,
          }}
        >
          {hasContent && firstNode ? (
            <div style={{ padding: "4px 12px 8px 12px", maxHeight: 260, overflowY: "auto" }}>
              <BranchTreeRows rows={rows} activePathIds={activePathIds} onSelect={handleSelect} />
            </div>
          ) : (
            <div style={{ padding: "10px 16px", fontSize: 12, color: "var(--text-muted)", fontStyle: "italic" }}>
              {noBranchReason ?? t("sessionHasNoBranches", "This session has no branches")}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
