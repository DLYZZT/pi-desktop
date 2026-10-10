import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
import { useI18n } from "@/i18n";
import type { SessionInfo } from "@/lib/types";
import { abbreviateHomePath } from "@/lib/display-path";
import { copyText } from "@/lib/clipboard";
import type { ProjectWorktreeInfo } from "@/hooks/useSidebarWorkspace";
import { ProjectBranchMenu } from "./ProjectBranchMenu";
import { RunningSessionIndicator, SessionTreeItem, UnreadSessionIndicator, type SessionTreeNode } from "./SessionTree";

const groupMenuItemStyle: CSSProperties = {
  width: "100%",
  minHeight: 30,
  display: "flex",
  alignItems: "center",
  gap: 8,
  padding: "0 9px",
  border: 0,
  borderRadius: 6,
  background: "transparent",
  color: "var(--text-muted)",
  cursor: "pointer",
  fontSize: 12,
  textAlign: "left",
};

export interface ProjectSessionGroupProps {
  projectRoot: string;
  homeDir: string;
  /** Fork-tree roots of this project's sessions. */
  nodes: SessionTreeNode[];
  sessionCount: number;
  runningCount: number;
  unreadCount: number;
  /** Branch of the most recent session, when it lives in a worktree. */
  branch: string | null;
  /** Loaded worktree facts for the project; null while loading or unavailable. */
  worktreeInfo: ProjectWorktreeInfo | null;
  /** True while the window context points at this project. */
  isActive: boolean;
  collapsed: boolean;
  selectedSessionId: string | null;
  selectedCwd: string | null;
  runningSessionIds: Set<string>;
  unreadSessionIds: Set<string>;
  onToggleCollapse: () => void;
  /** Move the window context to the project root (no session opened). */
  onActivateProject: () => void;
  onNewSessionInProject: () => void;
  /** Delete every session record of this project (code on disk is untouched). */
  onRemoveProject: () => void | Promise<void>;
  /** True while this project's removal is in flight. */
  removing?: boolean;
  onSelectSession: (session: SessionInfo) => void;
  onSelectWorktree: (path: string) => void;
  onWorktreeCreated: (path: string, branch: string) => void;
  onWorktreeRemoved: () => void;
  onRenamed?: () => void;
  onSessionDeleted?: (id: string) => void;
}

/**
 * One project in the aggregated session list: a collapsible header carrying the
 * project identity and live status, with the project's fork tree underneath.
 */
export function ProjectSessionGroup({
  projectRoot,
  homeDir,
  nodes,
  sessionCount,
  runningCount,
  unreadCount,
  branch,
  worktreeInfo,
  isActive,
  collapsed,
  selectedSessionId,
  selectedCwd,
  runningSessionIds,
  unreadSessionIds,
  onToggleCollapse,
  onActivateProject,
  onNewSessionInProject,
  onRemoveProject,
  removing = false,
  onSelectSession,
  onSelectWorktree,
  onWorktreeCreated,
  onWorktreeRemoved,
  onRenamed,
  onSessionDeleted,
}: ProjectSessionGroupProps) {
  const { t } = useI18n();
  const [hovered, setHovered] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const menuButtonRef = useRef<HTMLButtonElement>(null);

  const closeMenu = useCallback((restoreFocus = false) => {
    setMenuOpen(false);
    setConfirmRemove(false);
    if (restoreFocus) menuButtonRef.current?.focus();
  }, []);

  useEffect(() => {
    if (!menuOpen && !confirmRemove) return;
    const handler = (event: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
        setMenuOpen(false);
        setConfirmRemove(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [menuOpen, confirmRemove]);

  const label = abbreviateHomePath(projectRoot, homeDir);

  return (
    <section
      aria-labelledby={`project-group-label-${projectRoot}`}
      style={{
        margin: "0 0 2px",
        borderRadius: 8,
        background: isActive ? "var(--bg-selected)" : "transparent",
        border: isActive ? "1px solid var(--accent-soft-border)" : "1px solid transparent",
      }}
    >
      <div
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 4,
          minHeight: 32,
          padding: "0 4px 0 2px",
          borderRadius: 8,
        }}
      >
        <button
          type="button"
          onClick={() => onToggleCollapse()}
          title={
            collapsed
              ? t("expandProjectGroup", "Expand project group")
              : t("collapseProjectGroup", "Collapse project group")
          }
          aria-label={
            collapsed
              ? t("expandProjectGroup", "Expand project group")
              : t("collapseProjectGroup", "Collapse project group")
          }
          aria-expanded={!collapsed}
          aria-controls={`project-group-list-${projectRoot}`}
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            width: 20,
            height: 28,
            padding: 0,
            flexShrink: 0,
            background: "none",
            border: "none",
            borderRadius: 6,
            color: "var(--text-dim)",
            cursor: "pointer",
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
            style={{
              transform: collapsed ? "rotate(-90deg)" : "none",
              transition: "transform 0.15s",
            }}
          >
            <polyline points="2 3.5 5 6.5 8 3.5" />
          </svg>
        </button>

        <button
          type="button"
          id={`project-group-label-${projectRoot}`}
          onClick={() => {
            closeMenu();
            onToggleCollapse();
          }}
          title={
            collapsed
              ? t("expandProjectGroup", "Expand project group")
              : t("collapseProjectGroup", "Collapse project group")
          }
          style={{
            flex: 1,
            minWidth: 0,
            display: "flex",
            alignItems: "center",
            gap: 6,
            padding: 0,
            background: "none",
            border: "none",
            color: "var(--text)",
            cursor: "pointer",
            font: "inherit",
            textAlign: "left",
          }}
        >
          <svg
            width="12"
            height="12"
            viewBox="0 0 10 10"
            fill="none"
            stroke="var(--text-dim)"
            strokeWidth="1.1"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
            style={{ flexShrink: 0 }}
          >
            <path d="M1 3A1 1 0 0 1 2 2H4L5 3.5H8.5a.5.5 0 0 1 .5.5v4a.5.5 0 0 1-.5.5h-7A.5.5 0 0 1 1 8V3Z" />
          </svg>
          <span
            style={{
              flex: 1,
              minWidth: 0,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
              fontFamily: "var(--font-mono)",
              fontSize: 11.5,
              fontWeight: isActive ? 650 : 550,
              color: isActive ? "var(--text)" : "var(--text-muted)",
            }}
          >
            {label}
          </span>
        </button>

        <ProjectBranchMenu
          branch={branch}
          worktreeInfo={worktreeInfo}
          selectedCwd={selectedCwd}
          homeDir={homeDir}
          onSelectWorktree={onSelectWorktree}
          onWorktreeCreated={onWorktreeCreated}
          onWorktreeRemoved={onWorktreeRemoved}
        />

        <span
          title={t("projectSessionCount", "{count} sessions").replace("{count}", String(sessionCount))}
          style={{
            display: "flex",
            alignItems: "center",
            gap: 5,
            padding: "0 2px",
            color: "var(--text-dim)",
            flexShrink: 0,
          }}
        >
          {runningCount > 0 && (
            <span
              title={t("projectGroupRunning", "{count} running").replace("{count}", String(runningCount))}
              style={{ display: "flex", flexShrink: 0 }}
            >
              <RunningSessionIndicator />
            </span>
          )}
          {unreadCount > 0 && (
            <span
              title={t("projectGroupUnread", "{count} with new activity").replace("{count}", String(unreadCount))}
              style={{ display: "flex", flexShrink: 0 }}
            >
              <UnreadSessionIndicator />
            </span>
          )}
          <span style={{ fontSize: 10 }}>{sessionCount}</span>
        </span>

        <button
          type="button"
          onClick={(event) => {
            event.stopPropagation();
            closeMenu();
            onNewSessionInProject();
          }}
          title={t("newSessionInProject", "New session in this project")}
          aria-label={t("newSessionInProject", "New session in this project")}
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            width: 22,
            height: 22,
            padding: 0,
            flexShrink: 0,
            background: hovered ? "var(--bg-hover)" : "transparent",
            border: "none",
            borderRadius: 6,
            color: hovered ? "var(--text)" : "var(--text-dim)",
            cursor: "pointer",
          }}
        >
          <svg
            width="12"
            height="12"
            viewBox="0 0 10 10"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.3"
            strokeLinecap="round"
            aria-hidden="true"
          >
            <line x1="5" y1="1" x2="5" y2="9" />
            <line x1="1" y1="5" x2="9" y2="5" />
          </svg>
        </button>

        <div
          ref={menuRef}
          onKeyDown={(event) => {
            if (event.key !== "Escape" || !menuOpen) return;
            event.preventDefault();
            closeMenu(true);
          }}
          style={{ position: "relative", flexShrink: 0 }}
        >
          <button
            type="button"
            ref={menuButtonRef}
            onClick={(event) => {
              event.stopPropagation();
              setConfirmRemove(false);
              setMenuOpen((open) => !open);
            }}
            title={t("projectActions", "Project actions")}
            aria-label={t("projectActionsFor", "Project actions for {name}").replace("{name}", label)}
            aria-haspopup="menu"
            aria-expanded={menuOpen || confirmRemove}
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              width: 22,
              height: 22,
              padding: 0,
              background: menuOpen || hovered ? "var(--bg-hover)" : "transparent",
              border: "none",
              borderRadius: 6,
              color: menuOpen ? "var(--text)" : "var(--text-dim)",
              cursor: "pointer",
            }}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
              <circle cx="5" cy="12" r="1.7" />
              <circle cx="12" cy="12" r="1.7" />
              <circle cx="19" cy="12" r="1.7" />
            </svg>
          </button>
          {(menuOpen || confirmRemove) && (
            <div
              role={confirmRemove ? "alertdialog" : "menu"}
              aria-label={t("projectActions", "Project actions")}
              style={{
                position: "absolute",
                top: 24,
                right: 0,
                zIndex: 50,
                minWidth: confirmRemove ? 236 : 148,
                padding: 4,
                border: "1px solid var(--border)",
                borderRadius: 8,
                background: "var(--bg)",
                boxShadow: "0 8px 24px rgba(0,0,0,0.14)",
              }}
            >
              {confirmRemove ? (
                <div style={{ display: "flex", flexDirection: "column", gap: 8, padding: "6px 8px 4px" }}>
                  <span style={{ fontSize: 12, lineHeight: 1.5, color: "var(--text)" }}>
                    {sessionCount > 0
                      ? t(
                          "projectRemoveConfirm",
                          "Remove “{name}”? Its {count} session records are deleted; code on disk is untouched. This cannot be undone.",
                        )
                          .replace("{name}", label)
                          .replace("{count}", String(sessionCount))
                      : t("projectRemoveConfirmEmpty", "Remove “{name}” from the list?").replace("{name}", label)}
                  </span>
                  <div style={{ display: "flex", justifyContent: "flex-end", gap: 6 }}>
                    <button
                      type="button"
                      className="session-menu-item"
                      onClick={(event) => {
                        event.stopPropagation();
                        setConfirmRemove(false);
                      }}
                      disabled={removing}
                      style={{
                        ...groupMenuItemStyle,
                        width: "auto",
                        minHeight: 28,
                        justifyContent: "center",
                        padding: "0 10px",
                      }}
                    >
                      {t("cancel", "Cancel")}
                    </button>
                    <button
                      type="button"
                      className="session-menu-item"
                      onClick={(event) => {
                        event.stopPropagation();
                        void onRemoveProject();
                      }}
                      disabled={removing}
                      style={{
                        ...groupMenuItemStyle,
                        width: "auto",
                        minHeight: 28,
                        justifyContent: "center",
                        padding: "0 10px",
                        background: "var(--danger)",
                        color: "#fff",
                      }}
                    >
                      {removing ? t("projectRemoving", "Removing…") : t("projectRemove", "Remove project")}
                    </button>
                  </div>
                </div>
              ) : (
                <>
                  <button
                    type="button"
                    role="menuitem"
                    className="session-menu-item"
                    onClick={(event) => {
                      event.stopPropagation();
                      closeMenu();
                      onActivateProject();
                    }}
                    title={t("switchToProject", "Switch to project “{name}”").replace("{name}", label)}
                    style={groupMenuItemStyle}
                  >
                    <svg
                      width="13"
                      height="13"
                      viewBox="0 0 10 10"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.1"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      aria-hidden="true"
                    >
                      <path d="M1 3A1 1 0 0 1 2 2H4L5 3.5H8.5a.5.5 0 0 1 .5.5v4a.5.5 0 0 1-.5.5h-7A.5.5 0 0 1 1 8V3Z" />
                    </svg>
                    {t("openProject", "Open project")}
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    className="session-menu-item"
                    onClick={(event) => {
                      event.stopPropagation();
                      closeMenu();
                      void window.piBridge?.showItemInFolder(projectRoot);
                    }}
                    style={groupMenuItemStyle}
                  >
                    <svg
                      width="13"
                      height="13"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      aria-hidden="true"
                    >
                      <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
                    </svg>
                    {t("projectRevealInFolder", "Show in File Explorer")}
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    className="session-menu-item"
                    onClick={(event) => {
                      event.stopPropagation();
                      closeMenu();
                      void copyText(projectRoot).catch(() => {});
                    }}
                    style={groupMenuItemStyle}
                  >
                    <svg
                      width="13"
                      height="13"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      aria-hidden="true"
                    >
                      <rect x="9" y="9" width="13" height="13" rx="2" />
                      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
                    </svg>
                    {t("projectCopyPath", "Copy project path")}
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    className="session-menu-item"
                    onClick={(event) => {
                      event.stopPropagation();
                      setMenuOpen(false);
                      setConfirmRemove(true);
                    }}
                    disabled={removing}
                    title={t("projectRemoveHint", "Delete this project's session records; code on disk is untouched")}
                    style={{ ...groupMenuItemStyle, color: "#ef4444" }}
                  >
                    <svg
                      width="13"
                      height="13"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      aria-hidden="true"
                    >
                      <polyline points="3 6 5 6 21 6" />
                      <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                    </svg>
                    {t("projectRemove", "Remove project")}
                  </button>
                </>
              )}
            </div>
          )}
        </div>
      </div>

      {!collapsed &&
        (nodes.length > 0 ? (
          <div
            role="list"
            id={`project-group-list-${projectRoot}`}
            style={{ display: "flex", flexDirection: "column", paddingBottom: 4 }}
          >
            {nodes.map((node) => (
              <SessionTreeItem
                key={node.session.id}
                node={node}
                selectedSessionId={selectedSessionId}
                runningSessionIds={runningSessionIds}
                unreadSessionIds={unreadSessionIds}
                onSelectSession={onSelectSession}
                onRenamed={onRenamed}
                onSessionDeleted={onSessionDeleted}
                depth={0}
              />
            ))}
          </div>
        ) : (
          <div
            style={{
              padding: "0 10px 6px 28px",
              color: "var(--text-dim)",
              fontSize: 11,
            }}
          >
            {t("projectNoSessions", "No sessions yet")}
          </div>
        ))}
    </section>
  );
}
