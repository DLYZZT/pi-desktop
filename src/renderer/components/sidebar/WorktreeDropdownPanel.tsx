import { useState, useCallback, useRef } from "react";
import { useI18n } from "@/i18n";
import { abbreviateHomePath } from "@/lib/display-path";
import type { WorktreeEntry } from "@/hooks/useSidebarWorkspace";
import { PathLabel, useDeferredFocus } from "./WorkspaceDropdown";

export interface WorktreeDropdownPanelProps {
  worktrees: WorktreeEntry[];
  selectedCwd: string | null;
  homeDir: string;
  projectRoot: string;
  /** Switch the effective cwd. The host decides whether the dropdown closes. */
  onSelectWorktree: (path: string) => void;
  onWorktreeCreated: (path: string, branch: string) => void;
  onWorktreeRemoved: () => void;
}

/**
 * Worktree list plus the create/remove flows, shared by the sidebar's top-level
 * worktree switcher and the per-project branch menu in aggregated mode. Owns
 * its own transient UI state so both hosts stay thin.
 */
export function WorktreeDropdownPanel({
  worktrees,
  selectedCwd,
  homeDir,
  projectRoot,
  onSelectWorktree,
  onWorktreeCreated,
  onWorktreeRemoved,
}: WorktreeDropdownPanelProps) {
  const { t } = useI18n();
  const deferFocus = useDeferredFocus();
  const newInputRef = useRef<HTMLInputElement>(null);
  const [newOpen, setNewOpen] = useState(false);
  const [newBranch, setNewBranch] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null);

  const handleCreateWorktree = useCallback(async () => {
    const branch = newBranch.trim();
    if (!branch || busy) return;
    setBusy(true);
    setError(null);
    try {
      const { call } = await import("@/lib/api-client");
      const { worktree } = await call("worktrees.create", {
        projectRoot,
        cwd: projectRoot,
        branch,
      });
      setNewOpen(false);
      setNewBranch("");
      onWorktreeCreated(worktree.path, branch);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, [newBranch, busy, projectRoot, onWorktreeCreated]);

  const handleRemoveWorktree = useCallback(
    async (path: string, force: boolean) => {
      if (busy) return;
      setBusy(true);
      setError(null);
      try {
        const { call } = await import("@/lib/api-client");
        await call("worktrees.remove", {
          cwd: projectRoot,
          path,
          force,
        });
        setConfirmRemove(null);
        if (selectedCwd === path) onSelectWorktree(projectRoot);
        onWorktreeRemoved();
      } catch (e) {
        if (!force && (e as { detail?: { dirty?: boolean } }).detail?.dirty) {
          setConfirmRemove(path);
          return;
        }
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setBusy(false);
      }
    },
    [busy, projectRoot, selectedCwd, onSelectWorktree, onWorktreeRemoved],
  );

  return (
    <>
      <div style={{ maxHeight: "min(40vh, 300px)", overflowY: "auto" }}>
        {worktrees.map((wt) => {
          const isCurrent = wt.path === selectedCwd || (wt.isMain && !worktrees.some((w) => w.path === selectedCwd));
          if (confirmRemove === wt.path) {
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
                  disabled={busy}
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
                  onClick={() => setConfirmRemove(null)}
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
                  onSelectWorktree(wt.path);
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
                  disabled={busy}
                  title={t("removeWorktreeHint", "Remove worktree checkout {path}; the branch is kept").replace(
                    "{path}",
                    wt.path,
                  )}
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

      {!newOpen ? (
        <button
          onClick={(e) => {
            e.stopPropagation();
            setNewOpen(true);
            setError(null);
            deferFocus(() => newInputRef.current?.focus());
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
            ref={newInputRef}
            value={newBranch}
            onChange={(e) => {
              setNewBranch(e.target.value);
              setError(null);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                void handleCreateWorktree();
              }
              if (e.key === "Escape") {
                setNewOpen(false);
                setNewBranch("");
                setError(null);
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
              disabled={busy || !newBranch.trim()}
              style={{
                flex: 1,
                padding: "4px 0",
                background: "var(--accent)",
                border: "none",
                borderRadius: 5,
                color: "#fff",
                fontSize: 11,
                fontWeight: 600,
                cursor: busy || !newBranch.trim() ? "not-allowed" : "pointer",
                opacity: busy || !newBranch.trim() ? 0.65 : 1,
              }}
            >
              {busy ? t("creating", "Creating…") : t("create", "Create")}
            </button>
            <button
              onClick={() => {
                setNewOpen(false);
                setNewBranch("");
                setError(null);
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
      {error && (
        <div
          style={{
            padding: "5px 10px 8px",
            color: "#dc2626",
            fontSize: 11,
            lineHeight: 1.35,
            overflowWrap: "anywhere",
          }}
        >
          {error}
        </div>
      )}
    </>
  );
}
