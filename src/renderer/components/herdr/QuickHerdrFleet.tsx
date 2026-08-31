import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { call } from "@/lib/api-client";
import { useHerdrFleet } from "@/hooks/useHerdrFleet";
import { useHerdrRuntime } from "@/hooks/useHerdrRuntime";
import { useI18n } from "@/i18n";
import {
  getQuickChannelBindingPopoverLayout,
  type QuickChannelBindingPopoverLayout,
} from "@/lib/quick-channel-binding-layout";
import type { HerdrAgentState, HerdrPane } from "@contract/herdr";
import { countHerdrAgents, herdrPaneMatchesFilter } from "./fleet-selectors";
import { getFleetPresentation } from "./fleet-presentation";
import { herdrErrorLabel, herdrRuntimeStatusLabel, publicHerdrErrorLabel } from "./herdr-ui-copy";

const FILTER_STATES: Array<HerdrAgentState | "all"> = ["all", "working", "blocked", "idle", "done", "unknown"];

export function QuickHerdrFleet({
  isMobile,
  onOpenTerminal,
}: {
  isMobile: boolean;
  onOpenTerminal: (pane: HerdrPane) => void;
}) {
  const { t } = useI18n();
  const { runtime, loading: runtimeLoading, error: runtimeError, refresh: refreshRuntime } = useHerdrRuntime();
  const ready = runtime?.status === "ready";
  const { fleet, loading, error, refresh } = useHerdrFleet(ready);
  const { interactive, hasFleet, showEmpty } = getFleetPresentation(ready, fleet);
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState<HerdrAgentState | "all">("all");
  const [retrying, setRetrying] = useState(false);
  const [retryError, setRetryError] = useState<string | null>(null);
  const [popoverLayout, setPopoverLayout] = useState<QuickChannelBindingPopoverLayout | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const dialogId = useId();

  const stateLabel = useCallback(
    (state: HerdrAgentState | "all") => {
      if (state === "all") return t("allStates", "All states");
      if (state === "working") return t("herdrStateWorking", "Working");
      if (state === "blocked") return t("herdrStateBlocked", "Blocked");
      if (state === "idle") return t("herdrStateIdle", "Idle");
      if (state === "done") return t("herdrStateDone", "Done");
      return t("herdrStateUnknown", "Unknown");
    },
    [t],
  );

  const counts = useMemo(() => {
    return countHerdrAgents(fleet?.panes ?? []);
  }, [fleet?.panes]);
  const agentCount = Object.values(counts).reduce((total, count) => total + count, 0);

  const visiblePaneIds = useMemo(
    () => new Set((fleet?.panes ?? []).filter((pane) => herdrPaneMatchesFilter(pane, filter)).map((pane) => pane.id)),
    [filter, fleet?.panes],
  );

  const closePopover = useCallback((restoreFocus = false) => {
    setOpen(false);
    if (restoreFocus) window.requestAnimationFrame(() => triggerRef.current?.focus());
  }, []);

  const updatePopoverLayout = useCallback(() => {
    const trigger = triggerRef.current;
    if (!trigger) return;
    const next = getQuickChannelBindingPopoverLayout({
      trigger: trigger.getBoundingClientRect(),
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
      isMobile,
    });
    setPopoverLayout((previous) =>
      previous &&
      previous.left === next.left &&
      previous.top === next.top &&
      previous.width === next.width &&
      previous.maxHeight === next.maxHeight &&
      previous.placement === next.placement
        ? previous
        : next,
    );
  }, [isMobile]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: globalThis.PointerEvent) => {
      const target = event.target as Node;
      if (rootRef.current?.contains(target) || dialogRef.current?.contains(target)) return;
      closePopover();
    };
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") closePopover(true);
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [closePopover, open]);

  useLayoutEffect(() => {
    if (!open) return;
    updatePopoverLayout();
    const frame = window.requestAnimationFrame(() => dialogRef.current?.focus());
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(updatePopoverLayout);
    if (triggerRef.current) observer?.observe(triggerRef.current);
    if (rootRef.current?.parentElement) observer?.observe(rootRef.current.parentElement);
    window.addEventListener("resize", updatePopoverLayout);
    window.addEventListener("scroll", updatePopoverLayout, true);
    return () => {
      window.cancelAnimationFrame(frame);
      observer?.disconnect();
      window.removeEventListener("resize", updatePopoverLayout);
      window.removeEventListener("scroll", updatePopoverLayout, true);
    };
  }, [open, updatePopoverLayout]);

  if (!runtimeLoading && runtime?.status === "disabled") return null;
  if (!runtimeLoading && !runtime && !runtimeError) return null;

  const triggerState: HerdrAgentState = fleet?.stale
    ? "unknown"
    : counts.blocked
      ? "blocked"
      : counts.working
        ? "working"
        : counts.idle
          ? "idle"
          : counts.done
            ? "done"
            : "unknown";
  const emphasizedCount = counts.blocked || counts.working;
  const triggerLabel = isMobile
    ? t("agentFleetShort", "Fleet")
    : fleet?.stale
      ? `${t("agentFleet", "Agent Fleet")} · ${t("herdrSnapshotStale", "Snapshot stale")}`
      : ready && loading && !fleet
        ? t("agentFleet", "Agent Fleet")
        : emphasizedCount
          ? `${t("agentFleet", "Agent Fleet")} · ${emphasizedCount} ${stateLabel(triggerState)}`
          : `${t("agentFleet", "Agent Fleet")} · ${agentCount}`;
  const runtimeDetailBase = runtimeLoading
    ? t("loadingHerdr", "Loading Herdr…")
    : ready
      ? `v${runtime?.version ?? "?"} · ${runtime?.sessionName ?? "default"}`
      : herdrRuntimeStatusLabel(runtime?.status, t);
  const runtimeDetail = fleet?.stale
    ? `${runtimeDetailBase} · ${t("herdrSnapshotStale", "Snapshot stale")}`
    : runtimeDetailBase;
  const visibleError = runtime?.error
    ? publicHerdrErrorLabel(runtime.error, t)
    : (retryError ?? (error ? herdrErrorLabel(error, t) : runtimeError ? herdrErrorLabel(runtimeError, t) : null));

  const retryConnection = async () => {
    if (retrying) return;
    setRetrying(true);
    setRetryError(null);
    try {
      await call("herdr.runtime.connect");
    } catch (nextError) {
      setRetryError(herdrErrorLabel(nextError, t));
    } finally {
      setRetrying(false);
    }
  };

  return (
    <>
      <div ref={rootRef} style={{ position: "relative", marginLeft: 10, minWidth: 0, flexShrink: 1 }}>
        <button
          ref={triggerRef}
          type="button"
          data-testid="herdr-fleet-indicator"
          aria-haspopup="dialog"
          aria-expanded={open}
          aria-controls={open ? dialogId : undefined}
          title={`${t("agentFleet", "Agent Fleet")} · ${runtimeDetail}`}
          onClick={() => setOpen((value) => !value)}
          style={{
            minWidth: 0,
            maxWidth: isMobile ? 104 : 240,
            padding: "5px 9px",
            display: "flex",
            alignItems: "center",
            gap: 6,
            border: "1px solid var(--border)",
            borderRadius: 999,
            background: ready ? "color-mix(in srgb, var(--accent) 7%, var(--bg-panel))" : "var(--bg)",
            color: "var(--text-muted)",
            fontSize: 11,
            whiteSpace: "nowrap",
            cursor: "pointer",
            overflow: "hidden",
          }}
        >
          <span
            aria-hidden="true"
            style={{
              width: 7,
              height: 7,
              flexShrink: 0,
              borderRadius: "50%",
              background: ready ? statusColor(triggerState) : runtime?.status === "error" ? "#dc2626" : "#6b7280",
              boxShadow: ready && triggerState === "working" ? "0 0 0 2px rgba(37,99,235,.16)" : "none",
            }}
          />
          <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis" }}>{triggerLabel}</span>
          <span aria-hidden="true" style={{ fontSize: 9, opacity: 0.7 }}>
            ▾
          </span>
        </button>
      </div>

      {open &&
        popoverLayout &&
        typeof document !== "undefined" &&
        createPortal(
          <div
            ref={dialogRef}
            id={dialogId}
            role="dialog"
            tabIndex={-1}
            aria-label={t("agentFleet", "Agent Fleet")}
            data-testid="herdr-fleet-popover"
            data-placement={popoverLayout.placement}
            style={{
              position: "fixed",
              top: popoverLayout.top,
              left: popoverLayout.left,
              zIndex: 250,
              width: popoverLayout.width,
              maxHeight: popoverLayout.maxHeight,
              display: "flex",
              flexDirection: "column",
              overflow: "hidden",
              border: "1px solid var(--border)",
              borderRadius: 9,
              background: "var(--bg)",
              boxShadow: "0 12px 34px rgba(0,0,0,.22)",
              outline: "none",
            }}
          >
            <div style={{ flexShrink: 0, padding: "12px 12px 10px", borderBottom: "1px solid var(--border)" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <div style={{ minWidth: 0, flex: 1 }}>
                  <div style={{ color: "var(--text)", fontSize: 13, fontWeight: 700 }}>
                    {t("agentFleet", "Agent Fleet")}
                  </div>
                  <div
                    style={{
                      marginTop: 3,
                      color: "var(--text-dim)",
                      fontSize: 10,
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {runtimeDetail}
                  </div>
                </div>
                <button
                  type="button"
                  disabled={loading || runtimeLoading}
                  aria-label={t("refresh", "Refresh")}
                  title={t("refresh", "Refresh")}
                  onClick={() => void (ready ? refresh() : refreshRuntime())}
                  style={iconButtonStyle}
                >
                  ↻
                </button>
              </div>
              {hasFleet && (
                <select
                  value={filter}
                  onChange={(event) => setFilter(event.currentTarget.value as typeof filter)}
                  aria-label={t("filterAgentState", "Filter agent state")}
                  style={{ width: "100%", height: 30, marginTop: 10, fontSize: 11 }}
                >
                  {FILTER_STATES.map((state) => (
                    <option key={state} value={state}>
                      {stateLabel(state)}
                    </option>
                  ))}
                </select>
              )}
            </div>

            <div style={{ minHeight: 0, overflowY: "auto", overscrollBehavior: "contain", padding: 9 }}>
              {visibleError && (
                <div role="alert" style={errorStyle}>
                  {visibleError}
                </div>
              )}
              {!runtimeLoading && runtime && runtime.status !== "disabled" && !ready && (
                <div style={hintStyle}>
                  <div>
                    {runtime?.mode === "managed"
                      ? t(
                          "herdrManagedConnectHint",
                          "Pi Desktop starts this Session automatically. Check the runtime status or repair Herdr in Developer Tools.",
                        )
                      : t("herdrConnectHint", "Start the selected Herdr Session, then connect again.")}
                  </div>
                  <button
                    type="button"
                    disabled={retrying}
                    style={{ ...buttonStyle, marginTop: 10 }}
                    onClick={() => void retryConnection()}
                  >
                    {retrying ? t("connecting", "Connecting…") : t("retryConnection", "Retry connection")}
                  </button>
                </div>
              )}
              {showEmpty && <div style={hintStyle}>{t("noHerdrPanes", "This Herdr Session has no panes yet.")}</div>}
              {hasFleet && visiblePaneIds.size === 0 && (
                <div style={hintStyle}>{t("noHerdrPanesForState", "No panes match this agent state.")}</div>
              )}
              {hasFleet &&
                fleet?.workspaces.map((workspace) => {
                  const visibleTabs = workspace.tabs
                    .map((tab) => ({
                      tab,
                      panes: tab.paneIds
                        .filter((paneId) => visiblePaneIds.has(paneId))
                        .flatMap((paneId) => {
                          const pane = fleet.panes.find((item) => item.id === paneId);
                          return pane ? [pane] : [];
                        }),
                    }))
                    .filter(({ panes }) => panes.length > 0);
                  if (visibleTabs.length === 0) return null;
                  return (
                    <section key={workspace.id} style={{ marginBottom: 12 }}>
                      <div style={workspaceHeaderStyle}>
                        <span aria-hidden="true">▾</span>
                        <strong style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                          {workspace.name || workspace.id}
                        </strong>
                      </div>
                      {visibleTabs.map(({ tab, panes }) => (
                        <div key={tab.id} style={{ margin: "4px 0 8px 9px" }}>
                          <div style={{ color: "var(--text-dim)", fontSize: 10, padding: "3px 7px" }}>
                            {tab.name || tab.id}
                          </div>
                          {panes.map((pane) => {
                            const state = pane.agent?.state ?? "unknown";
                            return (
                              <button
                                key={pane.id}
                                type="button"
                                disabled={!interactive}
                                onClick={() => {
                                  onOpenTerminal(pane);
                                  closePopover();
                                }}
                                title={
                                  fleet.stale
                                    ? t("herdrSnapshotStale", "Snapshot stale")
                                    : t("openTerminal", "Open terminal")
                                }
                                style={{
                                  width: "100%",
                                  minHeight: 42,
                                  marginTop: 3,
                                  padding: "6px 8px",
                                  display: "grid",
                                  gridTemplateColumns: "8px minmax(0, 1fr) auto",
                                  alignItems: "center",
                                  gap: 8,
                                  textAlign: "left",
                                  border: `1px solid ${pane.focused ? "color-mix(in srgb, var(--accent) 45%, var(--border))" : "transparent"}`,
                                  borderRadius: 8,
                                  background: pane.focused ? "var(--accent-soft)" : "transparent",
                                  color: "var(--text)",
                                  cursor: fleet.stale ? "default" : "pointer",
                                  opacity: fleet.stale ? 0.65 : 1,
                                }}
                              >
                                <span
                                  aria-hidden="true"
                                  style={{ ...statusDotStyle, background: statusColor(state) }}
                                />
                                <span style={{ minWidth: 0 }}>
                                  <span
                                    style={{
                                      display: "block",
                                      overflow: "hidden",
                                      textOverflow: "ellipsis",
                                      whiteSpace: "nowrap",
                                      fontSize: 12,
                                      fontWeight: pane.focused ? 650 : 450,
                                    }}
                                  >
                                    {pane.agent?.name || pane.title || pane.id || t("shellPane", "Shell pane")}
                                  </span>
                                  <span
                                    style={{ display: "block", marginTop: 2, color: "var(--text-dim)", fontSize: 9 }}
                                  >
                                    {pane.agent?.kind ?? t("shellPane", "Shell pane")}
                                  </span>
                                </span>
                                <span style={{ color: "var(--text-muted)", fontSize: 9 }}>
                                  {pane.agent ? stateLabel(state) : t("shellPane", "Shell pane")}
                                </span>
                              </button>
                            );
                          })}
                        </div>
                      ))}
                    </section>
                  );
                })}
            </div>
          </div>,
          document.body,
        )}
    </>
  );
}

function statusColor(state?: HerdrAgentState): string {
  if (state === "working") return "#2563eb";
  if (state === "blocked") return "#dc2626";
  if (state === "done") return "#16a34a";
  if (state === "idle") return "#ca8a04";
  return "#6b7280";
}

const buttonStyle: React.CSSProperties = {
  minHeight: 32,
  padding: "0 12px",
  border: "1px solid var(--border)",
  borderRadius: 8,
  background: "var(--bg-panel)",
  color: "var(--text)",
  cursor: "pointer",
  fontSize: 11,
};
const iconButtonStyle: React.CSSProperties = { ...buttonStyle, width: 28, minHeight: 28, padding: 0, fontSize: 15 };
const workspaceHeaderStyle: React.CSSProperties = {
  display: "flex",
  gap: 7,
  alignItems: "center",
  padding: "5px 7px",
  color: "var(--text)",
  fontSize: 11,
};
const statusDotStyle: React.CSSProperties = { width: 7, height: 7, borderRadius: "50%" };
const hintStyle: React.CSSProperties = {
  border: "1px dashed var(--border)",
  borderRadius: 8,
  padding: 12,
  color: "var(--text-muted)",
  fontSize: 11,
  lineHeight: 1.6,
};
const errorStyle: React.CSSProperties = {
  marginBottom: 9,
  border: "1px solid rgba(239,68,68,.28)",
  borderRadius: 8,
  padding: 9,
  color: "#ef4444",
  fontSize: 10,
  overflowWrap: "anywhere",
};
