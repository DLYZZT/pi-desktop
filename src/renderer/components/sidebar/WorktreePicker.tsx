import { useState, useRef, useCallback, useEffect } from "react";
import { useI18n } from "@/i18n";
import type { WorktreeState } from "@/hooks/useSidebarWorkspace";
import { abbreviateHomePath } from "@/lib/display-path";
import { worktreePathsEqual } from "@shared/worktree-path";
import { PathLabel, AnimatedDropdown, useDeferredFocus } from "./WorkspaceDropdown";

interface Props {
  selectedCwd: string | null;
  selectedProject: string | null;
  homeDir: string;
  worktreeState: WorktreeState | null;
  worktreeLoadingCwd: string | null;
  setSelectedCwd: (cwd: string | null) => void;
  onCreated: (path: string, branch: string) => void;
  onRefresh: () => void;
}

export function WorktreePicker({
  selectedCwd,
  selectedProject,
  homeDir,
  worktreeState,
  worktreeLoadingCwd,
  setSelectedCwd,
  onCreated,
  onRefresh,
}: Props) {
  const { t } = useI18n();
  const deferFocus = useDeferredFocus();
  // Worktree switcher state
  const [wtDropdownOpen, setWtDropdownOpen] = useState(false);
  const [wtNewOpen, setWtNewOpen] = useState(false);
  const [wtNewBranch, setWtNewBranch] = useState("");
  const [wtError, setWtError] = useState<string | null>(null);
  const [wtBusy, setWtBusy] = useState(false);
  const [wtConfirmRemove, setWtConfirmRemove] = useState<string | null>(null);
  // Clicking the inactive worktree selector reveals why it is inactive
  const [wtGuideHintOpen, setWtGuideHintOpen] = useState(false);
  const wtGuideHintTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (wtGuideHintTimerRef.current) clearTimeout(wtGuideHintTimerRef.current);
    },
    [],
  );
  const wtDropdownRef = useRef<HTMLDivElement>(null);
  const wtNewInputRef = useRef<HTMLInputElement>(null);
  const handleCreateWorktree = useCallback(async () => {
    const branch = wtNewBranch.trim();
    if (!branch || wtBusy || !worktreeState) return;
    setWtBusy(true);
    setWtError(null);
    try {
      const { call } = await import("@/lib/api-client");
      const { worktree } = await call("worktrees.create", {
        projectRoot: worktreeState.projectRoot,
        cwd: worktreeState.projectRoot,
        branch,
      });
      setWtNewOpen(false);
      setWtNewBranch("");
      setWtDropdownOpen(false);
      onCreated(worktree.path, branch);
    } catch (e) {
      setWtError(e instanceof Error ? e.message : String(e));
    } finally {
      setWtBusy(false);
    }
  }, [wtNewBranch, wtBusy, worktreeState, onCreated]);

  const handleRemoveWorktree = useCallback(
    async (path: string, force: boolean) => {
      if (!worktreeState || wtBusy) return;
      setWtBusy(true);
      setWtError(null);
      try {
        const { call } = await import("@/lib/api-client");
        await call("worktrees.remove", {
          cwd: worktreeState.projectRoot,
          path,
          force,
        });
        setWtConfirmRemove(null);
        if (selectedCwd === path) setSelectedCwd(worktreeState.projectRoot);
        onRefresh();
      } catch (e) {
        if (!force && (e as { detail?: { dirty?: boolean } }).detail?.dirty) {
          setWtConfirmRemove(path);
          return;
        }
        setWtError(e instanceof Error ? e.message : String(e));
      } finally {
        setWtBusy(false);
      }
    },
    [worktreeState, wtBusy, selectedCwd, setSelectedCwd, onRefresh],
  );

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (wtDropdownRef.current && !wtDropdownRef.current.contains(e.target as Node)) {
        setWtDropdownOpen(false);
        setWtNewOpen(false);
        setWtNewBranch("");
        setWtError(null);
        setWtConfirmRemove(null);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  const showWorktreeSwitcher = Boolean(
    worktreeState?.isGit &&
    worktreeState.isTopLevel &&
    selectedCwd &&
    selectedProject &&
    worktreePathsEqual(selectedProject, worktreeState.projectRoot),
  );
  const worktreeGuide =
    selectedCwd &&
    worktreeState &&
    selectedProject &&
    worktreePathsEqual(selectedProject, worktreeState.projectRoot) &&
    !showWorktreeSwitcher
      ? worktreeState.isGit
        ? {
            label: t("worktreeOpenRepoRoot", "Open repo root"),
            title: t("worktreeOpenRepoRootHint", "Open the repository root to manage worktrees."),
          }
        : {
            label: t("worktreeRepoRootOnly", "Git repo root only"),
            title: t("worktreeRepoRootOnlyHint", "Worktrees are available in Git repository roots."),
          }
      : null;
  const worktreeLoading = Boolean(selectedCwd && worktreeLoadingCwd === selectedCwd);
  const inactiveWorktreeSelector =
    worktreeGuide ??
    (worktreeLoading && !showWorktreeSwitcher
      ? {
          label: t("worktrees", "Worktrees…"),
          title: t("worktreeChecking", "Checking worktrees for this directory."),
        }
      : null);

  return (
    <>
      {/* Worktree switcher — shown only for git projects at a checkout top
            level (repo subdirs keep their own project identity, so switching
            from them would jump projects). Rendered whenever the selected cwd
            belongs to the loaded project (not just when forCwd matches), so
            switching between worktrees of one project keeps the row mounted
            instead of flickering while data refetches: all worktrees of a
            project share the same list anyway. */}
      {showWorktreeSwitcher &&
        (() => {
          if (!worktreeState) return null;
          const currentWt =
            worktreeState.worktrees.find((w) => w.path === selectedCwd) ??
            worktreeState.worktrees.find((w) => w.isMain);
          return (
            <div ref={wtDropdownRef} style={{ position: "relative", marginTop: 6 }}>
              <button
                onClick={() => setWtDropdownOpen((v) => !v)}
                title={
                  currentWt
                    ? t("switchWorktreePath", "Switch worktree: {path}").replace("{path}", currentWt.path)
                    : t("switchWorktree", "Switch worktree")
                }
                style={{
                  width: "100%",
                  height: 29,
                  boxSizing: "border-box",
                  display: "flex",
                  alignItems: "center",
                  gap: 6,
                  padding: "0 10px",
                  background: "var(--bg-hover)",
                  border: "1px solid var(--border)",
                  borderRadius: 7,
                  cursor: "pointer",
                  fontSize: 11,
                  lineHeight: 1.35,
                  color: "var(--text-muted)",
                  textAlign: "left",
                }}
              >
                <svg
                  width="11"
                  height="11"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  style={{
                    flexShrink: 0,
                    color: currentWt && !currentWt.isMain ? "var(--accent)" : "var(--text-dim)",
                  }}
                >
                  <line x1="6" y1="3" x2="6" y2="15" />
                  <circle cx="18" cy="6" r="3" />
                  <circle cx="6" cy="18" r="3" />
                  <path d="M18 9a9 9 0 0 1-9 9" />
                </svg>
                <PathLabel
                  text={currentWt ? (currentWt.branch ?? abbreviateHomePath(currentWt.path, homeDir)) : "…"}
                  style={{ flex: 1, fontFamily: "var(--font-mono)", color: "var(--text)" }}
                />
                {currentWt?.isMain && (
                  <span style={{ flexShrink: 0, color: "var(--text-dim)", fontSize: 10 }}>
                    {t("mainBranch", "main")}
                  </span>
                )}
                {worktreeState.worktrees.length > 1 && (
                  <span style={{ flexShrink: 0, color: "var(--text-dim)", fontSize: 10 }}>
                    {worktreeState.worktrees.length}
                  </span>
                )}
                <svg
                  width="9"
                  height="9"
                  viewBox="0 0 10 10"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.8"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  style={{ flexShrink: 0 }}
                >
                  <polyline points="2 3.5 5 6.5 8 3.5" />
                </svg>
              </button>

              <AnimatedDropdown
                open={wtDropdownOpen}
                style={{
                  position: "absolute",
                  top: "calc(100% + 4px)",
                  left: 0,
                  right: 0,
                  zIndex: 100,
                  background: "var(--bg)",
                  border: "1px solid var(--border)",
                  borderRadius: 8,
                  boxShadow: "0 6px 20px rgba(0,0,0,0.10)",
                  overflow: "hidden",
                }}
              >
                <div style={{ maxHeight: "min(40vh, 300px)", overflowY: "auto" }}>
                  {worktreeState.worktrees.map((wt) => {
                    const isCurrent =
                      wt.path === selectedCwd ||
                      (wt.isMain && !worktreeState.worktrees.some((w) => w.path === selectedCwd));
                    if (wtConfirmRemove === wt.path) {
                      return (
                        <div
                          key={wt.path}
                          style={{
                            display: "flex",
                            alignItems: "center",
                            gap: 6,
                            padding: "7px 10px",
                            borderBottom: "1px solid var(--border)",
                            background: "rgba(239,68,68,0.06)",
                          }}
                        >
                          <span
                            style={{
                              flex: 1,
                              fontSize: 11,
                              color: "var(--text)",
                              overflow: "hidden",
                              textOverflow: "ellipsis",
                              whiteSpace: "nowrap",
                            }}
                          >
                            {t("worktreeForceRemoveConfirm", "Uncommitted changes. Force remove checkout?")}
                          </span>
                          <button
                            onClick={() => void handleRemoveWorktree(wt.path, true)}
                            disabled={wtBusy}
                            style={{
                              padding: "3px 9px",
                              background: "#ef4444",
                              border: "none",
                              borderRadius: 5,
                              color: "#fff",
                              fontSize: 11,
                              fontWeight: 600,
                              cursor: "pointer",
                              flexShrink: 0,
                            }}
                          >
                            {t("force", "Force")}
                          </button>
                          <button
                            onClick={() => setWtConfirmRemove(null)}
                            style={{
                              padding: "3px 9px",
                              background: "var(--bg-hover)",
                              border: "1px solid var(--border)",
                              borderRadius: 5,
                              color: "var(--text-muted)",
                              fontSize: 11,
                              cursor: "pointer",
                              flexShrink: 0,
                            }}
                          >
                            {t("cancel", "Cancel")}
                          </button>
                        </div>
                      );
                    }
                    return (
                      <div
                        key={wt.path}
                        className="wt-row"
                        style={{ display: "flex", alignItems: "center", borderBottom: "1px solid var(--border)" }}
                      >
                        <button
                          onClick={() => {
                            setSelectedCwd(wt.path);
                            setWtDropdownOpen(false);
                            setWtError(null);
                          }}
                          title={wt.path}
                          style={{
                            flex: 1,
                            minWidth: 0,
                            display: "flex",
                            alignItems: "center",
                            gap: 7,
                            padding: "8px 10px",
                            background: "var(--bg)",
                            border: "none",
                            color: isCurrent ? "var(--text)" : "var(--text-muted)",
                            cursor: "pointer",
                            textAlign: "left",
                            fontSize: 11,
                            fontFamily: "var(--font-mono)",
                          }}
                        >
                          {isCurrent ? (
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
                          <PathLabel text={wt.branch ?? abbreviateHomePath(wt.path, homeDir)} style={{ flex: 1 }} />
                          {wt.isMain && (
                            <span style={{ flexShrink: 0, color: "var(--text-dim)", fontSize: 10 }}>
                              {t("mainBranch", "main")}
                            </span>
                          )}
                        </button>
                        {!wt.isMain && (
                          <button
                            onClick={() => void handleRemoveWorktree(wt.path, false)}
                            disabled={wtBusy}
                            title={t(
                              "removeWorktreeHint",
                              "Remove worktree checkout {path}; the branch is kept",
                            ).replace("{path}", wt.path)}
                            style={{
                              display: "flex",
                              alignItems: "center",
                              justifyContent: "center",
                              width: 34,
                              height: 28,
                              padding: 0,
                              marginRight: 4,
                              background: "none",
                              border: "none",
                              color: "var(--text-dim)",
                              cursor: "pointer",
                              borderRadius: 5,
                              flexShrink: 0,
                              transition: "color 0.12s, background 0.12s",
                            }}
                            onMouseEnter={(e) => {
                              e.currentTarget.style.color = "#ef4444";
                              e.currentTarget.style.background = "rgba(239,68,68,0.08)";
                            }}
                            onMouseLeave={(e) => {
                              e.currentTarget.style.color = "var(--text-dim)";
                              e.currentTarget.style.background = "none";
                            }}
                          >
                            <svg
                              width="12"
                              height="12"
                              viewBox="0 0 24 24"
                              fill="none"
                              stroke="currentColor"
                              strokeWidth="2"
                              strokeLinecap="round"
                              strokeLinejoin="round"
                            >
                              <polyline points="3 6 5 6 21 6" />
                              <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
                              <path d="M10 11v6M14 11v6" />
                              <path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" />
                            </svg>
                          </button>
                        )}
                      </div>
                    );
                  })}
                </div>

                {!wtNewOpen ? (
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      setWtNewOpen(true);
                      setWtError(null);
                      deferFocus(() => wtNewInputRef.current?.focus());
                    }}
                    title={t("createWorktreeHint", "Create a worktree checkout for a branch")}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 7,
                      width: "100%",
                      padding: "8px 10px",
                      background: "none",
                      border: "none",
                      color: "var(--text-muted)",
                      cursor: "pointer",
                      textAlign: "left",
                      fontSize: 11,
                    }}
                  >
                    <svg
                      width="10"
                      height="10"
                      viewBox="0 0 10 10"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.1"
                      strokeLinecap="round"
                      style={{ flexShrink: 0 }}
                    >
                      <line x1="5" y1="1" x2="5" y2="9" />
                      <line x1="1" y1="5" x2="9" y2="5" />
                    </svg>
                    <span>{t("newWorktree", "New worktree…")}</span>
                  </button>
                ) : (
                  <div style={{ padding: "6px 8px" }}>
                    <input
                      ref={wtNewInputRef}
                      value={wtNewBranch}
                      onChange={(e) => {
                        setWtNewBranch(e.target.value);
                        setWtError(null);
                      }}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") {
                          e.preventDefault();
                          void handleCreateWorktree();
                        }
                        if (e.key === "Escape") {
                          setWtNewOpen(false);
                          setWtNewBranch("");
                          setWtError(null);
                        }
                      }}
                      placeholder={t("branchName", "branch name")}
                      style={{
                        width: "100%",
                        fontSize: 11,
                        fontFamily: "var(--font-mono)",
                        padding: "5px 8px",
                        border: "1px solid var(--accent)",
                        borderRadius: 5,
                        outline: "none",
                        background: "var(--bg)",
                        color: "var(--text)",
                        boxSizing: "border-box",
                      }}
                    />
                    <div style={{ display: "flex", gap: 5, marginTop: 5 }}>
                      <button
                        onClick={() => void handleCreateWorktree()}
                        disabled={wtBusy || !wtNewBranch.trim()}
                        style={{
                          flex: 1,
                          padding: "4px 0",
                          background: "var(--accent)",
                          border: "none",
                          borderRadius: 5,
                          color: "#fff",
                          fontSize: 11,
                          fontWeight: 600,
                          cursor: wtBusy || !wtNewBranch.trim() ? "not-allowed" : "pointer",
                          opacity: wtBusy || !wtNewBranch.trim() ? 0.65 : 1,
                        }}
                      >
                        {wtBusy ? t("creating", "Creating…") : t("create", "Create")}
                      </button>
                      <button
                        onClick={() => {
                          setWtNewOpen(false);
                          setWtNewBranch("");
                          setWtError(null);
                        }}
                        style={{
                          flex: 1,
                          padding: "4px 0",
                          background: "var(--bg-hover)",
                          border: "1px solid var(--border)",
                          borderRadius: 5,
                          color: "var(--text-muted)",
                          fontSize: 11,
                          cursor: "pointer",
                        }}
                      >
                        {t("cancel", "Cancel")}
                      </button>
                    </div>
                  </div>
                )}
                {wtError && (
                  <div
                    style={{
                      padding: "5px 10px 8px",
                      color: "#dc2626",
                      fontSize: 11,
                      lineHeight: 1.35,
                      overflowWrap: "anywhere",
                    }}
                  >
                    {wtError}
                  </div>
                )}
              </AnimatedDropdown>
            </div>
          );
        })()}
      {inactiveWorktreeSelector && (
        <>
          <button
            type="button"
            aria-disabled="true"
            tabIndex={-1}
            title={inactiveWorktreeSelector.title}
            onClick={() => {
              // No action is available here; clicking reveals the reason
              setWtGuideHintOpen(true);
              if (wtGuideHintTimerRef.current) clearTimeout(wtGuideHintTimerRef.current);
              wtGuideHintTimerRef.current = setTimeout(() => {
                wtGuideHintTimerRef.current = null;
                setWtGuideHintOpen(false);
              }, 4000);
            }}
            style={{
              width: "100%",
              height: 29,
              boxSizing: "border-box",
              marginTop: 6,
              display: "flex",
              alignItems: "center",
              gap: 6,
              padding: "0 10px",
              border: "1px solid var(--border)",
              borderRadius: 7,
              background: "var(--bg-hover)",
              color: "var(--text-dim)",
              fontSize: 11,
              lineHeight: 1.35,
              whiteSpace: "nowrap",
              textAlign: "left",
              cursor: "default",
              opacity: 0.82,
            }}
          >
            <svg
              width="11"
              height="11"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              style={{ flexShrink: 0 }}
            >
              <line x1="6" y1="3" x2="6" y2="15" />
              <circle cx="18" cy="6" r="3" />
              <circle cx="6" cy="18" r="3" />
              <path d="M18 9a9 9 0 0 1-9 9" />
            </svg>
            <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>{inactiveWorktreeSelector.label}</span>
          </button>
          {wtGuideHintOpen && (
            <div
              style={{
                marginTop: 4,
                padding: "6px 10px",
                fontSize: 11,
                lineHeight: 1.45,
                color: "var(--text-muted)",
                background: "var(--bg-hover)",
                border: "1px solid var(--border)",
                borderRadius: 7,
              }}
            >
              {inactiveWorktreeSelector.title}
            </div>
          )}
        </>
      )}
    </>
  );
}
