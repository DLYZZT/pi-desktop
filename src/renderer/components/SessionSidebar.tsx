import { subscribeRunning } from "@/lib/api-client";
import { useEffect, useState, useCallback, useRef, useSyncExternalStore } from "react";
import type { SessionInfo } from "@/lib/types";
import { useI18n } from "@/i18n";
import {
  loadUnreadSessionIds as loadStoredUnreadSessionIds,
  saveUnreadSessionIds as saveStoredUnreadSessionIds,
} from "@/lib/unread-session-storage";
import {
  filterSessionsForQuery,
  resolveInitialSessionRestore,
  sessionDateGroup,
  type SessionDateGroup,
} from "@/lib/session-list";
import type { SessionListStore } from "@/lib/session-list-store";
import { worktreePathsEqual } from "@shared/worktree-path";
import { buildSessionTree, SessionTreeItem, type SessionTreeNode } from "./sidebar/SessionTree";
import { PiAgentTitle } from "./sidebar/PiAgentTitle";
import { ProjectPicker } from "./sidebar/ProjectPicker";
import { WorktreePicker } from "./sidebar/WorktreePicker";
import { useSidebarWorkspace, getRecentProjects } from "@/hooks/useSidebarWorkspace";

interface Props {
  selectedSessionId: string | null;
  onSelectSession: (session: SessionInfo, isRestore?: boolean) => void;
  onNewSession?: (sessionId: string, cwd: string) => void;
  initialSessionId?: string | null;
  onInitialRestoreDone?: () => void;
  sessionList: SessionListStore;
  worktreesRefreshKey?: number;
  onSessionDeleted?: (sessionId: string) => void;
  selectedCwd?: string | null;
  onCwdChange?: (cwd: string | null, projectRoot?: string | null) => void;
}

function loadUnreadSessionIds(): Set<string> {
  if (typeof window === "undefined") return new Set();
  try {
    return loadStoredUnreadSessionIds(window.localStorage);
  } catch {
    return new Set();
  }
}

function saveUnreadSessionIds(ids: Set<string>): void {
  if (typeof window === "undefined") return;
  try {
    saveStoredUnreadSessionIds(window.localStorage, ids);
  } catch {
    // ignore storage quota / privacy-mode errors
  }
}

export function SessionSidebar({
  selectedSessionId,
  onSelectSession,
  onNewSession,
  initialSessionId,
  onInitialRestoreDone,
  sessionList,
  worktreesRefreshKey,
  onSessionDeleted,
  selectedCwd: selectedCwdProp,
  onCwdChange,
}: Props) {
  const { t } = useI18n();
  const {
    sessions: allSessions,
    loading,
    error: listError,
    runningSessionIds: fallbackRunningIds,
  } = useSyncExternalStore(sessionList.subscribe, sessionList.getSnapshot, sessionList.getSnapshot);
  const error =
    listError == null
      ? null
      : (listError instanceof Error ? listError.message : String(listError)) ||
        t("sessionListLoadFailed", "Failed to load sessions.");
  const {
    selectedCwd,
    setSelectedCwd,
    selectedProject,
    homeDir,
    worktreeState,
    worktreeLoadingCwd,
    registerCreatedWorktree,
    refreshWorktrees,
  } = useSidebarWorkspace({ allSessions, selectedCwd: selectedCwdProp, onCwdChange, worktreesRefreshKey });
  const [sessionFilter, setSessionFilter] = useState("");
  const [sessionRefreshDone, setSessionRefreshDone] = useState(false);
  const [runningSessionIds, setRunningSessionIds] = useState<Set<string>>(() => new Set());
  const [unreadSessionIds, setUnreadSessionIds] = useState<Set<string>>(() => loadUnreadSessionIds());
  const previousRunningSessionIdsRef = useRef<Set<string>>(new Set());
  // Once the live stream has delivered a frame it is the source of truth for
  // running state; late session responses must not overwrite it.
  const streamAuthoritativeRef = useRef(false);
  const sessionRefreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const sidebarMountedRef = useRef(false);
  useEffect(() => {
    sidebarMountedRef.current = true;
    return () => {
      sidebarMountedRef.current = false;
      if (sessionRefreshTimerRef.current) clearTimeout(sessionRefreshTimerRef.current);
    };
  }, []);

  const loadSessions = useCallback(
    async (showLoading = false) => {
      await sessionList.refresh(showLoading).catch(() => {});
      if (!sidebarMountedRef.current) return;
      if (!showLoading && sessionList.getSnapshot().error === null) {
        setSessionRefreshDone(true);
        if (sessionRefreshTimerRef.current) clearTimeout(sessionRefreshTimerRef.current);
        sessionRefreshTimerRef.current = setTimeout(() => {
          sessionRefreshTimerRef.current = null;
          setSessionRefreshDone(false);
        }, 2000);
      }
    },
    [sessionList],
  );

  useEffect(() => {
    if (!streamAuthoritativeRef.current) setRunningSessionIds(new Set(fallbackRunningIds));
  }, [fallbackRunningIds]);

  useEffect(() => {
    if (loading || listError !== null) return;
    const existingIds = new Set(allSessions.map((session) => session.id));
    setUnreadSessionIds((previous) => {
      const next = new Set([...previous].filter((id) => existingIds.has(id)));
      return next.size === previous.size ? previous : next;
    });
  }, [allSessions, listError, loading]);

  // Persist unread markers so they survive a browser refresh before the user
  // has actually opened the completed session.
  useEffect(() => {
    saveUnreadSessionIds(unreadSessionIds);
  }, [unreadSessionIds]);

  useEffect(() => {
    let disposed = false;
    let unsubscribe: (() => void) | undefined;
    void subscribeRunning((event) => {
      if (disposed) return;
      streamAuthoritativeRef.current = true;
      setRunningSessionIds(new Set(event.sessionIds));
    })
      .then((off) => {
        if (disposed) off();
        else unsubscribe = off;
      })
      .catch(() => {});
    return () => {
      disposed = true;
      unsubscribe?.();
    };
  }, []);

  useEffect(() => {
    return sessionList.subscribeDeleted((id) => {
      setUnreadSessionIds((previous) => {
        if (!previous.has(id)) return previous;
        const next = new Set(previous);
        next.delete(id);
        return next;
      });
      onSessionDeleted?.(id);
    });
  }, [sessionList, onSessionDeleted]);

  useEffect(() => {
    const previous = previousRunningSessionIdsRef.current;
    const completedInBackground = [...previous].filter((id) => !runningSessionIds.has(id) && id !== selectedSessionId);
    const newlyRunning = [...runningSessionIds];

    if (completedInBackground.length > 0 || newlyRunning.length > 0) {
      setUnreadSessionIds((prev) => {
        const next = new Set(prev);
        newlyRunning.forEach((id) => next.delete(id));
        completedInBackground.forEach((id) => next.add(id));
        return next;
      });
    }

    previousRunningSessionIdsRef.current = runningSessionIds;
  }, [runningSessionIds, selectedSessionId]);

  useEffect(() => {
    if (!selectedSessionId) return;
    setUnreadSessionIds((prev) => {
      if (!prev.has(selectedSessionId)) return prev;
      const next = new Set(prev);
      next.delete(selectedSessionId);
      return next;
    });
  }, [selectedSessionId]);

  const restoredRef = useRef(false);

  // Auto-select cwd and restore session from URL on first load
  useEffect(() => {
    const restore = resolveInitialSessionRestore(
      allSessions,
      initialSessionId,
      loading,
      error !== null,
      restoredRef.current,
    );
    if (restore.status === "wait") return;
    if (restore.status === "restore") {
      restoredRef.current = true;
      setSelectedCwd(restore.session.cwd);
      onSelectSession(restore.session, true);
      return;
    }
    if (restore.status === "not-found") {
      restoredRef.current = true;
      onInitialRestoreDone?.();
    }

    if (selectedCwd === null) {
      const projects = getRecentProjects(allSessions);
      if (projects.length > 0) setSelectedCwd(projects[0]);
    }
  }, [
    allSessions,
    error,
    initialSessionId,
    loading,
    onInitialRestoreDone,
    onSelectSession,
    selectedCwd,
    setSelectedCwd,
  ]);

  // Clicking a session moves the effective cwd to that session's worktree.
  // Done on the click path (not via the selectedCwd prop sync) so it also
  // works when the prop value won't change — e.g. re-clicking the already
  // open session after manually switching worktrees.
  const handleSelectSessionFromList = useCallback(
    (s: SessionInfo) => {
      if (s.cwd) setSelectedCwd(s.cwd);
      onSelectSession(s);
    },
    [onSelectSession, setSelectedCwd],
  );

  const handleNewSession = useCallback(() => {
    if (!selectedCwd) return;
    // Generate a temporary UUID client-side — no backend call needed.
    // Pi will be spawned lazily when the user sends the first message.
    const tempId =
      typeof crypto.randomUUID === "function"
        ? crypto.randomUUID()
        : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
    onNewSession?.(tempId, selectedCwd);
  }, [selectedCwd, onNewSession]);

  // Sessions of every worktree in the selected project are shown together.
  // Paths come from mixed sources (session files, git output) and may differ
  // in separators/casing on Windows, so compare with worktreePathsEqual.
  const projectSessions = selectedProject
    ? allSessions.filter((s) => worktreePathsEqual(s.projectRoot ?? s.cwd, selectedProject))
    : allSessions;
  const filteredSessions = filterSessionsForQuery(projectSessions, sessionFilter);
  // Build parent-child tree within the filtered set
  const sessionTree = buildSessionTree(filteredSessions);
  const sessionGroups: { id: SessionDateGroup; label: string; nodes: SessionTreeNode[] }[] = [
    { id: "today", label: t("sessionsToday", "Today"), nodes: [] },
    { id: "recent", label: t("sessionsRecent", "Last 7 days"), nodes: [] },
    { id: "older", label: t("sessionsOlder", "Older"), nodes: [] },
  ];
  for (const node of sessionTree) {
    sessionGroups.find((group) => group.id === sessionDateGroup(node.session.modified))?.nodes.push(node);
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", overflow: "hidden" }}>
      {/* Header */}
      <div
        style={{
          padding: "16px 16px 12px",
          borderBottom: "1px solid var(--border)",
          flexShrink: 0,
          display: "flex",
          flexDirection: "column",
          gap: 10,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <PiAgentTitle />
          <button
            onClick={() => loadSessions(false)}
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              background: sessionRefreshDone
                ? "color-mix(in srgb, var(--success) 18%, transparent)"
                : "var(--bg-hover)",
              border: `1px solid ${sessionRefreshDone ? "color-mix(in srgb, var(--success) 40%, transparent)" : "var(--border)"}`,
              color: sessionRefreshDone ? "var(--success)" : "var(--text-muted)",
              cursor: "pointer",
              width: 32,
              height: 32,
              borderRadius: 7,
              padding: 0,
              flexShrink: 0,
              transition: "background 0.3s, color 0.3s, border-color 0.3s",
            }}
            onMouseEnter={(e) => {
              if (sessionRefreshDone) return;
              e.currentTarget.style.background = "var(--bg-selected)";
              e.currentTarget.style.color = "var(--accent)";
              e.currentTarget.style.borderColor = "var(--accent-soft-border)";
            }}
            onMouseLeave={(e) => {
              if (sessionRefreshDone) return;
              e.currentTarget.style.background = "var(--bg-hover)";
              e.currentTarget.style.color = "var(--text-muted)";
              e.currentTarget.style.borderColor = "var(--border)";
            }}
            title={t("refresh", "Refresh")}
          >
            {sessionRefreshDone ? (
              <svg
                width="15"
                height="15"
                viewBox="0 0 24 24"
                fill="none"
                stroke="var(--success)"
                strokeWidth="2.5"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <polyline points="20 6 9 17 4 12" />
              </svg>
            ) : (
              <svg
                width="15"
                height="15"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
                <path d="M3 3v5h5" />
              </svg>
            )}
          </button>
        </div>

        <button
          onClick={handleNewSession}
          disabled={!selectedCwd}
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            gap: 6,
            width: "100%",
            padding: "8px 10px",
            background: selectedCwd ? "var(--text)" : "var(--bg-hover)",
            border: "none",
            color: selectedCwd ? "var(--bg)" : "var(--text-dim)",
            cursor: selectedCwd ? "pointer" : "not-allowed",
            borderRadius: 7,
            fontSize: 12.5,
            fontWeight: 600,
            fontFamily: "var(--font-mono)",
            flexShrink: 0,
            transition: "opacity 0.12s",
            opacity: selectedCwd ? 1 : 0.7,
          }}
          title={
            selectedCwd
              ? `${t("newSessionIn", "New session in selected project")}: ${selectedCwd}`
              : t("selectProjectFirst", "Select a project first")
          }
          onMouseEnter={(e) => {
            if (!selectedCwd) return;
            e.currentTarget.style.opacity = "0.9";
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.opacity = selectedCwd ? "1" : "0.7";
          }}
        >
          <span style={{ fontSize: 14, lineHeight: 1 }}>+</span>
          {t("newSession", "new session")}
        </button>
        <ProjectPicker
          selectedCwd={selectedCwd}
          selectedProject={selectedProject}
          homeDir={homeDir}
          allSessions={allSessions}
          restoringInitialSession={Boolean(initialSessionId && !restoredRef.current)}
          setSelectedCwd={setSelectedCwd}
        />
        <WorktreePicker
          selectedCwd={selectedCwd}
          selectedProject={selectedProject}
          homeDir={homeDir}
          worktreeState={worktreeState}
          worktreeLoadingCwd={worktreeLoadingCwd}
          setSelectedCwd={setSelectedCwd}
          onCreated={registerCreatedWorktree}
          onRefresh={refreshWorktrees}
        />
      </div>

      {/* Session list */}
      <nav
        aria-label={t("sessions", "Sessions")}
        style={{ flex: "1 1 auto", overflowY: "auto", padding: "0", minHeight: 80 }}
      >
        <div style={{ padding: "10px 10px 6px" }}>
          <div
            style={{
              padding: "0 4px 7px",
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              gap: 8,
              fontFamily: "var(--font-mono)",
              fontSize: 12,
              color: "var(--text-dim)",
              letterSpacing: "0.5px",
              textTransform: "uppercase",
            }}
          >
            <span>{t("sessions", "Sessions")}</span>
            <span
              aria-label={t("sessionCount", "{count} sessions").replace("{count}", String(filteredSessions.length))}
            >
              {filteredSessions.length}
            </span>
          </div>
          <div style={{ position: "relative" }}>
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              aria-hidden="true"
              style={{
                position: "absolute",
                left: 10,
                top: "50%",
                transform: "translateY(-50%)",
                color: "var(--text-dim)",
                pointerEvents: "none",
              }}
            >
              <circle cx="11" cy="11" r="7" />
              <line x1="20" y1="20" x2="16.5" y2="16.5" />
            </svg>
            <input
              type="search"
              value={sessionFilter}
              onChange={(event) => setSessionFilter(event.target.value)}
              placeholder={t("searchSessions", "Search sessions")}
              aria-label={t("searchSessions", "Search sessions")}
              style={{
                width: "100%",
                height: 34,
                padding: "0 30px 0 32px",
                border: "1px solid var(--border)",
                borderRadius: 8,
                background: "var(--bg-panel)",
                color: "var(--text)",
                fontSize: 13,
                outline: "none",
              }}
            />
            {sessionFilter && (
              <button
                type="button"
                onClick={() => setSessionFilter("")}
                title={t("clearSessionSearch", "Clear session search")}
                aria-label={t("clearSessionSearch", "Clear session search")}
                style={{
                  position: "absolute",
                  top: 1,
                  right: 1,
                  width: 32,
                  height: 32,
                  border: 0,
                  borderRadius: 7,
                  background: "transparent",
                  color: "var(--text-dim)",
                  cursor: "pointer",
                  fontSize: 18,
                  lineHeight: 1,
                }}
              >
                ×
              </button>
            )}
          </div>
        </div>
        {loading && (
          <div style={{ padding: "16px 14px", color: "var(--text-muted)", fontSize: 12 }}>
            {t("loading", "Loading…")}
          </div>
        )}
        {error && <div style={{ padding: "12px 14px", color: "var(--danger)", fontSize: 12 }}>{error}</div>}
        {!loading && !error && filteredSessions.length === 0 && (
          <div style={{ padding: "16px 14px", color: "var(--text-muted)", fontSize: 13 }}>
            {sessionFilter.trim()
              ? t("noMatchingSessions", "No matching sessions")
              : t("noSessionsFound", "No sessions found")}
          </div>
        )}
        <div style={{ padding: "0 6px 10px", display: "flex", flexDirection: "column", gap: 4 }}>
          {sessionGroups.map(
            (group) =>
              group.nodes.length > 0 && (
                <section key={group.id} aria-labelledby={`session-group-${group.id}`}>
                  <div
                    id={`session-group-${group.id}`}
                    style={{
                      padding: "7px 8px 4px",
                      color: "var(--text-dim)",
                      fontSize: 12,
                      fontWeight: 650,
                    }}
                  >
                    {group.label}
                  </div>
                  <div role="list" style={{ display: "flex", flexDirection: "column" }}>
                    {group.nodes.map((node) => (
                      <SessionTreeItem
                        key={node.session.id}
                        node={node}
                        selectedSessionId={selectedSessionId}
                        runningSessionIds={runningSessionIds}
                        unreadSessionIds={unreadSessionIds}
                        onSelectSession={handleSelectSessionFromList}
                        onRenamed={sessionList.refreshIfDisconnected}
                        onSessionDeleted={(id) => {
                          sessionList.applyChange({ cwd: null, sessionId: id, deleted: true });
                        }}
                        depth={0}
                      />
                    ))}
                  </div>
                </section>
              ),
          )}
        </div>
      </nav>
    </div>
  );
}
