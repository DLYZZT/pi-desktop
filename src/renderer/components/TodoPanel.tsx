/**
 * Floating plan card, top-right of the conversation. Mirrors the plan the agent
 * wrote with `todo_write`: the model owns the list, the user only reads it, so
 * there is no checkbox and no write-back path.
 *
 * Dismissal is per session and lasts until the plan changes: closing the card
 * hides it, and the next `todo_write` brings it back.
 */
import { useEffect, useState } from "react";
import { useI18n } from "@/i18n";
import type { TodoPlanState } from "@/lib/types";
import { Button } from "./ui/Button";
import { ChevronDown, ChevronUp, X } from "lucide-react";

export interface TodoPanelProps {
  plan: TodoPlanState;
  /** Dock below the notice shelf instead of at the very top. */
  onDismiss?: () => void;
}

function statusLabel(status: TodoPlanState["items"][number]["status"], t: (key: string, fallback: string) => string) {
  if (status === "completed") return t("todoStatusCompleted", "Completed");
  if (status === "in_progress") return t("todoStatusInProgress", "In progress");
  return t("todoStatusPending", "Not started");
}

export function TodoPanel({ plan, onDismiss }: TodoPanelProps) {
  const { t } = useI18n();
  const done = plan.completed >= plan.items.length && plan.items.length > 0;
  // A finished plan collapses on its own: the user no longer needs the detail.
  const [collapsed, setCollapsed] = useState(done);
  const [collapsedByUser, setCollapsedByUser] = useState(false);

  useEffect(() => {
    if (done) setCollapsed(true);
    else if (!collapsedByUser) setCollapsed(false);
  }, [done, collapsedByUser]);

  const active = plan.items.find((item) => item.status === "in_progress");
  const summary = active?.content ?? plan.items[plan.items.length - 1]?.content ?? "";

  return (
    <div
      role="region"
      aria-label={t("todoPlanTitle", "Plan")}
      style={{
        display: "grid",
        width: "min(320px, 100%)",
        border: "1px solid var(--border)",
        borderRadius: 10,
        background: "var(--bg-panel)",
        boxShadow: "0 8px 28px color-mix(in srgb, #000 14%, transparent)",
        overflow: "hidden",
        pointerEvents: "auto",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 6, minWidth: 0, padding: "7px 8px 7px 10px" }}>
        <Button
          variant="ghost"
          onClick={() => {
            setCollapsed((value) => {
              if (value) setCollapsedByUser(false);
              else setCollapsedByUser(true);
              return !value;
            });
          }}
          aria-expanded={!collapsed}
          title={collapsed ? t("todoPlanExpand", "Show plan") : t("todoPlanCollapse", "Hide plan")}
          style={{ display: "flex", alignItems: "center", gap: 6, flex: 1, minWidth: 0, padding: "2px 4px" }}
        >
          <span
            style={{
              fontSize: 11,
              fontFamily: "var(--font-mono)",
              color: done ? "var(--text-dim)" : "var(--accent-chip-fg)",
              background: done ? "transparent" : "var(--accent-chip-bg)",
              borderRadius: 999,
              padding: "1px 6px",
              flexShrink: 0,
            }}
          >
            {t("todoPlanTitle", "Plan")} {plan.completed}/{plan.items.length}
          </span>
          {collapsed ? (
            <span
              style={{
                flex: "1 1 0",
                minWidth: 0,
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
                fontSize: 12,
                color: "var(--text-muted)",
                textAlign: "left",
              }}
            >
              {summary}
            </span>
          ) : null}
          {collapsed ? (
            <ChevronDown size={14} strokeWidth={1.8} aria-hidden="true" style={{ flexShrink: 0 }} />
          ) : (
            <ChevronUp size={14} strokeWidth={1.8} aria-hidden="true" style={{ flexShrink: 0 }} />
          )}
        </Button>
        {onDismiss ? (
          <Button
            variant="ghost"
            size="icon"
            onClick={onDismiss}
            title={t("todoPlanDismiss", "Hide until the plan changes")}
            aria-label={t("todoPlanDismiss", "Hide until the plan changes")}
            style={{ width: 24, height: 24, flexShrink: 0 }}
          >
            <X size={13} strokeWidth={1.8} aria-hidden="true" />
          </Button>
        ) : null}
      </div>

      {!collapsed ? (
        <ol
          style={{
            listStyle: "none",
            margin: 0,
            padding: "2px 10px 9px",
            display: "grid",
            gap: 5,
            maxHeight: "min(40vh, 320px)",
            overflowY: "auto",
          }}
        >
          {plan.items.map((item, index) => (
            <li
              key={`${index}-${item.content}`}
              title={statusLabel(item.status, t)}
              style={{ display: "flex", alignItems: "flex-start", gap: 7, minWidth: 0 }}
            >
              <ItemGlyph status={item.status} />
              <span
                style={{
                  fontSize: 13,
                  lineHeight: 1.45,
                  color: item.status === "completed" ? "var(--text-dim)" : "var(--text)",
                  minWidth: 0,
                  wordBreak: "break-word",
                }}
              >
                {item.content}
              </span>
            </li>
          ))}
        </ol>
      ) : null}
    </div>
  );
}

function ItemGlyph({ status }: { status: TodoPlanState["items"][number]["status"] }) {
  if (status === "completed")
    return (
      <span
        aria-hidden="true"
        style={{
          width: 13,
          height: 13,
          marginTop: 2,
          flexShrink: 0,
          borderRadius: "50%",
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          background: "var(--text-dim)",
          color: "var(--bg-panel)",
          fontSize: 9,
          lineHeight: 1,
        }}
      >
        ✓
      </span>
    );
  if (status === "in_progress")
    return (
      <span
        aria-hidden="true"
        className="todo-item-active"
        style={{
          width: 13,
          height: 13,
          marginTop: 2,
          flexShrink: 0,
          borderRadius: "50%",
          border: "2px solid var(--accent)",
        }}
      />
    );
  return (
    <span
      aria-hidden="true"
      style={{
        width: 13,
        height: 13,
        marginTop: 2,
        flexShrink: 0,
        borderRadius: "50%",
        border: "1.5px solid var(--border)",
      }}
    />
  );
}
