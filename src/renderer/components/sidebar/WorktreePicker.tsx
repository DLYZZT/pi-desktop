import { useState, useRef, useCallback, useEffect } from "react";
import { useI18n } from "@/i18n";
import type { WorktreeState } from "@/hooks/useSidebarWorkspace";
import { abbreviateHomePath } from "@/lib/display-path";
import { worktreePathsEqual } from "@shared/worktree-path";
import { AnimatedDropdown, PathLabel } from "./WorkspaceDropdown";
import { WorktreeDropdownPanel } from "./WorktreeDropdownPanel";

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
  // Worktree switcher state
  const [wtDropdownOpen, setWtDropdownOpen] = useState(false);
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

  const closeDropdown = useCallback(() => {
    setWtDropdownOpen(false);
  }, []);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (wtDropdownRef.current && !wtDropdownRef.current.contains(e.target as Node)) {
        setWtDropdownOpen(false);
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
                <WorktreeDropdownPanel
                  worktrees={worktreeState.worktrees}
                  selectedCwd={selectedCwd}
                  homeDir={homeDir}
                  projectRoot={worktreeState.projectRoot}
                  onSelectWorktree={(path) => {
                    setSelectedCwd(path);
                    closeDropdown();
                  }}
                  onWorktreeCreated={(path, branch) => {
                    onCreated(path, branch);
                    closeDropdown();
                  }}
                  onWorktreeRemoved={() => {
                    onRefresh();
                  }}
                />
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
