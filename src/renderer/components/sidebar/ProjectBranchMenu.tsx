import { useEffect, useRef, useState } from "react";
import { useI18n } from "@/i18n";
import type { ProjectWorktreeInfo } from "@/hooks/useSidebarWorkspace";
import { AnimatedDropdown } from "./WorkspaceDropdown";
import { WorktreeDropdownPanel } from "./WorktreeDropdownPanel";

export interface ProjectBranchMenuProps {
  /** Branch to display: the active worktree's branch, else the main branch. */
  branch: string | null;
  /** Loaded worktree facts for the project; null while loading or unavailable. */
  worktreeInfo: ProjectWorktreeInfo | null;
  selectedCwd: string | null;
  homeDir: string;
  onSelectWorktree: (path: string) => void;
  onWorktreeCreated: (path: string, branch: string) => void;
  onWorktreeRemoved: () => void;
}

/**
 * Branch chip on a project group header. Git repositories at a checkout top
 * level get a dropdown that switches worktrees and creates/removes them, so
 * aggregated mode keeps the full worktree workflow without a top-level picker.
 */
export function ProjectBranchMenu({
  branch,
  worktreeInfo,
  selectedCwd,
  homeDir,
  onSelectWorktree,
  onWorktreeCreated,
  onWorktreeRemoved,
}: ProjectBranchMenuProps) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const handler = (event: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  const interactive = Boolean(worktreeInfo?.isGit && worktreeInfo.isTopLevel && worktreeInfo.worktrees.length > 0);
  if (!branch && !interactive) return null;

  const title = interactive
    ? t("switchWorktree", "Switch worktree")
    : t("projectBranchTitle", "Branch: {branch}").replace("{branch}", branch ?? "");

  return (
    <div ref={containerRef} style={{ position: "relative", flexShrink: 0, maxWidth: 96 }}>
      <button
        type="button"
        disabled={!interactive}
        onClick={(event) => {
          event.stopPropagation();
          if (interactive) setOpen((value) => !value);
        }}
        title={title}
        aria-label={title}
        aria-haspopup={interactive ? "menu" : undefined}
        aria-expanded={interactive ? open : undefined}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 3,
          maxWidth: "100%",
          padding: "1px 5px",
          background: "var(--accent-chip-bg)",
          border: "none",
          borderRadius: 4,
          color: "var(--accent-chip-fg)",
          fontFamily: "var(--font-mono)",
          fontSize: 10,
          lineHeight: 1.5,
          cursor: interactive ? "pointer" : "default",
        }}
      >
        <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{branch ?? "…"}</span>
        {interactive && (
          <svg
            width="8"
            height="8"
            viewBox="0 0 10 10"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
            style={{ flexShrink: 0 }}
          >
            <polyline points="2 3.5 5 6.5 8 3.5" />
          </svg>
        )}
      </button>
      {interactive && open && worktreeInfo && (
        <AnimatedDropdown
          open={open}
          style={{
            position: "absolute",
            top: "calc(100% + 4px)",
            right: 0,
            zIndex: 60,
            minWidth: 200,
            background: "var(--bg)",
            border: "1px solid var(--border)",
            borderRadius: 8,
            boxShadow: "0 8px 24px rgba(0,0,0,0.14)",
            overflow: "hidden",
          }}
        >
          <WorktreeDropdownPanel
            worktrees={worktreeInfo.worktrees}
            selectedCwd={selectedCwd}
            homeDir={homeDir}
            projectRoot={worktreeInfo.projectRoot}
            onSelectWorktree={(path) => {
              onSelectWorktree(path);
              setOpen(false);
            }}
            onWorktreeCreated={(path, createdBranch) => {
              onWorktreeCreated(path, createdBranch);
              setOpen(false);
            }}
            onWorktreeRemoved={() => {
              onWorktreeRemoved();
            }}
          />
        </AnimatedDropdown>
      )}
    </div>
  );
}
