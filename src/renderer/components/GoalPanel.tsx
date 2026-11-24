/**
 * Floating goal card, below the plan card. The model owns the work; the user
 * owns the decision: accept a verified goal, send it back with feedback, add
 * budget when the continuation allowance ran out, or stop it. Acceptance is
 * deliberately a click, not a model claim — `goal_report` only opens the door.
 */
import { useEffect, useState } from "react";
import { useI18n } from "@/i18n";
import type { GoalResolveAction, GoalState } from "@/lib/types";
import { Button } from "./ui/Button";
import { Textarea } from "./ui/Textarea";
import { ChevronDown, ChevronUp, X } from "lucide-react";

export interface GoalPanelProps {
  state: GoalState;
  onAction: (action: GoalResolveAction, feedback?: string) => void | Promise<void>;
  onDismiss?: () => void;
}

function statusLabel(status: GoalState["status"], t: (key: string, fallback: string) => string) {
  if (status === "working") return t("goalStatusWorking", "In progress");
  if (status === "awaiting_acceptance") return t("goalStatusAwaitingAcceptance", "Ready for review");
  if (status === "budget_exhausted") return t("goalStatusBudgetExhausted", "Budget exhausted");
  if (status === "accepted") return t("goalStatusAccepted", "Accepted");
  return t("goalStatusStopped", "Stopped");
}

export function GoalPanel({ state, onAction, onDismiss }: GoalPanelProps) {
  const { t } = useI18n();
  const terminal = state.status === "accepted" || state.status === "stopped";
  // A decided goal collapses on its own; the user no longer needs the detail.
  const [collapsed, setCollapsed] = useState(terminal);
  const [collapsedByUser, setCollapsedByUser] = useState(false);
  const [feedbackOpen, setFeedbackOpen] = useState(false);
  const [feedback, setFeedback] = useState("");
  const [pending, setPending] = useState<GoalResolveAction | null>(null);

  useEffect(() => {
    if (terminal) setCollapsed(true);
    else if (!collapsedByUser) setCollapsed(false);
  }, [terminal, collapsedByUser]);

  // Once the goal moves on, a half-written send-back no longer applies.
  useEffect(() => {
    if (state.status !== "awaiting_acceptance") {
      setFeedbackOpen(false);
      setFeedback("");
    }
  }, [state.status]);

  const run = async (action: GoalResolveAction, text?: string) => {
    if (pending) return;
    setPending(action);
    try {
      await onAction(action, text);
      if (action === "reject") {
        setFeedbackOpen(false);
        setFeedback("");
      }
    } finally {
      setPending(null);
    }
  };

  const busy = pending !== null;
  const report = state.report;

  return (
    <div
      role="region"
      aria-label={t("goalPanelTitle", "Goal")}
      style={{
        display: "grid",
        width: "min(360px, 100%)",
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
          title={collapsed ? t("goalExpand", "Show goal") : t("goalCollapse", "Hide goal")}
          style={{ display: "flex", alignItems: "center", gap: 6, flex: 1, minWidth: 0, padding: "2px 4px" }}
        >
          <span
            style={{
              fontSize: 11,
              fontFamily: "var(--font-mono)",
              color: terminal ? "var(--text-dim)" : "var(--accent-chip-fg)",
              background: terminal ? "transparent" : "var(--accent-chip-bg)",
              borderRadius: 999,
              padding: "1px 6px",
              flexShrink: 0,
            }}
          >
            {t("goalPanelTitle", "Goal")}
          </span>
          <span
            style={{
              flex: "0 0 auto",
              fontSize: 11,
              color: state.status === "budget_exhausted" ? "var(--warning)" : "var(--text-muted)",
            }}
          >
            {statusLabel(state.status, t)}
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
              {state.goal}
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
            title={t("goalDismiss", "Hide until the goal changes")}
            aria-label={t("goalDismiss", "Hide until the goal changes")}
            style={{ width: 24, height: 24, flexShrink: 0 }}
          >
            <X size={13} strokeWidth={1.8} aria-hidden="true" />
          </Button>
        ) : null}
      </div>

      {!collapsed ? (
        <div style={{ display: "grid", gap: 8, padding: "2px 10px 10px" }}>
          <div style={{ fontSize: 13, lineHeight: 1.45, color: "var(--text)", wordBreak: "break-word" }}>
            {state.goal}
          </div>
          <div style={{ fontSize: 11, fontFamily: "var(--font-mono)", color: "var(--text-dim)" }}>
            {t("goalBudget", "{used}/{max} auto-continues")
              .replace("{used}", String(state.continuations))
              .replace("{max}", String(state.maxContinuations))}
          </div>

          {report ? (
            <div style={{ display: "grid", gap: 6 }}>
              <div style={{ fontSize: 11, color: "var(--text-muted)" }}>
                {t("goalCriteriaTitle", "Acceptance criteria")}
              </div>
              {report.summary ? (
                <div style={{ fontSize: 12, lineHeight: 1.45, color: "var(--text-muted)", wordBreak: "break-word" }}>
                  {report.summary}
                </div>
              ) : null}
              <ol style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: 6 }}>
                {report.criteria.map((criterion, index) => (
                  <li
                    key={`${index}-${criterion.criterion}`}
                    style={{ display: "flex", alignItems: "flex-start", gap: 7, minWidth: 0 }}
                  >
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
                        background: criterion.met ? "var(--text-dim)" : "transparent",
                        border: criterion.met ? "none" : "1.5px solid var(--border)",
                        color: "var(--bg-panel)",
                        fontSize: 9,
                        lineHeight: 1,
                      }}
                    >
                      {criterion.met ? "✓" : ""}
                    </span>
                    <span style={{ display: "grid", gap: 2, minWidth: 0 }}>
                      <span
                        style={{
                          fontSize: 13,
                          lineHeight: 1.4,
                          color: criterion.met ? "var(--text)" : "var(--text-muted)",
                          wordBreak: "break-word",
                        }}
                      >
                        {criterion.criterion}
                      </span>
                      {criterion.evidence ? (
                        <span
                          style={{
                            fontSize: 11,
                            lineHeight: 1.4,
                            color: "var(--text-dim)",
                            wordBreak: "break-word",
                          }}
                        >
                          {criterion.evidence}
                        </span>
                      ) : null}
                    </span>
                  </li>
                ))}
              </ol>
            </div>
          ) : state.criteria.length ? (
            <div style={{ display: "grid", gap: 4 }}>
              <div style={{ fontSize: 11, color: "var(--text-muted)" }}>
                {t("goalCriteriaTitle", "Acceptance criteria")}
              </div>
              <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: 4 }}>
                {state.criteria.map((criterion, index) => (
                  <li
                    key={`${index}-${criterion}`}
                    style={{ fontSize: 12, lineHeight: 1.45, color: "var(--text-muted)", wordBreak: "break-word" }}
                  >
                    {criterion}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          {state.feedback && state.status === "working" ? (
            <div style={{ fontSize: 12, lineHeight: 1.45, color: "var(--text-dim)", wordBreak: "break-word" }}>
              {state.feedback}
            </div>
          ) : null}

          {feedbackOpen && state.status === "awaiting_acceptance" ? (
            <div style={{ display: "grid", gap: 6 }}>
              <Textarea
                mono={false}
                value={feedback}
                onChange={(event) => setFeedback(event.target.value)}
                placeholder={t("goalRejectPlaceholder", "What still needs work?")}
                style={{ minHeight: 54 }}
                aria-label={t("goalRejectPlaceholder", "What still needs work?")}
              />
              <div style={{ display: "flex", gap: 6, justifyContent: "flex-end" }}>
                <Button
                  size="sm"
                  disabled={busy}
                  onClick={() => {
                    setFeedbackOpen(false);
                    setFeedback("");
                  }}
                >
                  {t("goalRejectCancel", "Cancel")}
                </Button>
                <Button size="sm" variant="primary" disabled={busy} onClick={() => void run("reject", feedback)}>
                  {t("goalRejectSubmit", "Confirm send back")}
                </Button>
              </div>
            </div>
          ) : null}

          {state.status === "working" ? (
            <div style={{ display: "flex", gap: 6, justifyContent: "flex-end" }}>
              <Button size="sm" variant="danger" disabled={busy} onClick={() => void run("stop")}>
                {t("goalStop", "Stop goal")}
              </Button>
            </div>
          ) : null}

          {state.status === "awaiting_acceptance" ? (
            <div style={{ display: "flex", gap: 6, justifyContent: "flex-end", flexWrap: "wrap" }}>
              <Button size="sm" variant="danger" disabled={busy} onClick={() => void run("stop")}>
                {t("goalStop", "Stop goal")}
              </Button>
              <Button
                size="sm"
                disabled={busy}
                onClick={() => setFeedbackOpen((value) => !value)}
                aria-expanded={feedbackOpen}
              >
                {t("goalReject", "Send back")}
              </Button>
              <Button size="sm" variant="primary" disabled={busy} onClick={() => void run("accept")}>
                {t("goalAccept", "Accept")}
              </Button>
            </div>
          ) : null}

          {state.status === "budget_exhausted" ? (
            <div style={{ display: "flex", gap: 6, justifyContent: "flex-end", flexWrap: "wrap" }}>
              <Button size="sm" variant="danger" disabled={busy} onClick={() => void run("stop")}>
                {t("goalStop", "Stop goal")}
              </Button>
              <Button size="sm" disabled={busy} onClick={() => void run("accept")}>
                {t("goalAccept", "Accept")}
              </Button>
              <Button size="sm" variant="primary" disabled={busy} onClick={() => void run("extend")}>
                {t("goalExtend", "Add budget")}
              </Button>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
