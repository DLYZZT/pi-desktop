import { call, subscribeRunning } from "@/lib/api-client";
import {
  useEffect,
  useLayoutEffect,
  useState,
  useCallback,
  useRef,
  useSyncExternalStore,
  type CSSProperties,
  type ReactNode,
} from "react";
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
import { abbreviateHomePath } from "@/lib/display-path";
import { worktreePathsEqual } from "@shared/worktree-path";
import { buildSessionTree, SessionTreeItem, type SessionTreeNode } from "./sidebar/SessionTree";
import { PiAgentTitle } from "./sidebar/PiAgentTitle";

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

interface WorktreeEntry {
  path: string;
  branch: string | null;
  isMain: boolean;
}

interface WorktreeState {
  /** The cwd this data was fetched for — guards against stale responses */
  forCwd: string;
  projectRoot: string;
  isGit: boolean;
  /** False when forCwd is a repo subdirectory — the switcher is hidden there
   *  because subdir sessions keep their own project identity */
  isTopLevel: boolean;
  worktrees: WorktreeEntry[];
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

/**
 * Return all projects (deduped by projectRoot so worktrees collapse into their
 * main repo) sorted by most recent session activity.
 */
function getRecentProjects(sessions: SessionInfo[]): string[] {
  const latestByRoot = new Map<string, string>(); // projectRoot -> most recent modified
  for (const s of sessions) {
    const root = s.projectRoot ?? s.cwd;
    if (!root) continue;
    const prev = latestByRoot.get(root);
    if (!prev || s.modified > prev) {
      latestByRoot.set(root, s.modified);
    }
  }
  return [...latestByRoot.entries()].sort((a, b) => b[1].localeCompare(a[1])).map(([root]) => root);
}

/**
 * Path label that ellipsizes on the LEFT, keeping the (most relevant) trailing
 * segments visible: "…space/pi-desktop". Shows as much of the path as fits
 * instead of a fixed number of segments. The rtl container moves the ellipsis
 * to the left edge; the inner plaintext bidi isolation keeps the path itself
 * rendered strictly left-to-right (no punctuation reordering).
 */
function PathLabel({ text, style }: { text: string; style?: CSSProperties }) {
  return (
    <span
      style={{
        overflow: "hidden",
        textOverflow: "ellipsis",
        whiteSpace: "nowrap",
        display: "block",
        minWidth: 0,
        lineHeight: 1.35,
        direction: "rtl",
        textAlign: "left",
        ...style,
      }}
    >
      <span style={{ unicodeBidi: "plaintext" }}>{text}</span>
    </span>
  );
}

const DROPDOWN_ANIMATION_MS = 140;

function AnimatedDropdown({ open, children, style }: { open: boolean; children: ReactNode; style: CSSProperties }) {
  const [mounted, setMounted] = useState(open);
  const [visible, setVisible] = useState(open);

  useEffect(() => {
    let frame: number | undefined;
    let timeout: ReturnType<typeof setTimeout> | undefined;

    if (open) {
      setMounted(true);
      setVisible(false);
      frame = window.requestAnimationFrame(() => {
        frame = window.requestAnimationFrame(() => setVisible(true));
      });
    } else {
      setVisible(false);
      timeout = setTimeout(() => setMounted(false), DROPDOWN_ANIMATION_MS);
    }

    return () => {
      if (frame !== undefined) window.cancelAnimationFrame(frame);
      if (timeout) clearTimeout(timeout);
    };
  }, [open]);

  if (!mounted) return null;

  return (
    <div
      style={{
        ...style,
        opacity: visible ? 1 : 0,
        transform: visible ? "translateY(0) scale(1)" : "translateY(-8px) scale(0.96)",
        transformOrigin: "top center",
        transition: `opacity ${DROPDOWN_ANIMATION_MS}ms ease, transform ${DROPDOWN_ANIMATION_MS}ms ease`,
        pointerEvents: open ? "auto" : "none",
      }}
    >
      {children}
    </div>
  );
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
  const [selectedCwd, setSelectedCwd] = useState<string | null>(null);
  const [homeDir, setHomeDir] = useState<string>("");
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const [projectFilter, setProjectFilter] = useState("");
  const [sessionFilter, setSessionFilter] = useState("");
  const [customPathOpen, setCustomPathOpen] = useState(false);
  const [customPathValue, setCustomPathValue] = useState("");
  const [customPathError, setCustomPathError] = useState<string | null>(null);
  const [customPathValidating, setCustomPathValidating] = useState(false);
  const customPathInputRef = useRef<HTMLInputElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);
  // Worktree switcher state
  const [worktreeState, setWorktreeState] = useState<WorktreeState | null>(null);
  const [wtDropdownOpen, setWtDropdownOpen] = useState(false);
  const [wtNewOpen, setWtNewOpen] = useState(false);
  const [wtNewBranch, setWtNewBranch] = useState("");
  const [wtError, setWtError] = useState<string | null>(null);
  const [wtBusy, setWtBusy] = useState(false);
  const [wtConfirmRemove, setWtConfirmRemove] = useState<string | null>(null);
  const [worktreeLoadingCwd, setWorktreeLoadingCwd] = useState<string | null>(null);
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
  const [sessionRefreshDone, setSessionRefreshDone] = useState(false);
  const [runningSessionIds, setRunningSessionIds] = useState<Set<string>>(() => new Set());
  const [unreadSessionIds, setUnreadSessionIds] = useState<Set<string>>(() => loadUnreadSessionIds());
  const previousRunningSessionIdsRef = useRef<Set<string>>(new Set());
  // Once the live stream has delivered a frame it is the source of truth for
  // running state; late session responses must not overwrite it.
  const streamAuthoritativeRef = useRef(false);
  const sessionRefreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const deferredFocusTimersRef = useRef<Set<ReturnType<typeof setTimeout>>>(new Set());
  const sidebarMountedRef = useRef(false);
  const deferFocus = useCallback((focus: () => void) => {
    const timer = setTimeout(() => {
      deferredFocusTimersRef.current.delete(timer);
      focus();
    }, 0);
    deferredFocusTimersRef.current.add(timer);
  }, []);

  useEffect(() => {
    const deferredFocusTimers = deferredFocusTimersRef.current;
    sidebarMountedRef.current = true;
    return () => {
      sidebarMountedRef.current = false;
      if (sessionRefreshTimerRef.current) clearTimeout(sessionRefreshTimerRef.current);
      for (const timer of deferredFocusTimers) clearTimeout(timer);
      deferredFocusTimers.clear();
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

  useEffect(() => {
    call("system.home")
      .then((d: { home?: string }) => {
        if (d.home) setHomeDir(d.home);
      })
      .catch(() => {});
  }, []);

  const restoredRef = useRef(false);

  /** Resolve the project root for a cwd from the freshest data available */
  const projectRootFor = useCallback(
    (cwd: string | null): string | null => {
      if (!cwd) return null;
      if (worktreeState && worktreeState.forCwd === cwd) return worktreeState.projectRoot;
      // Any path in the loaded worktree list belongs to that project — covers
      // worktrees without sessions, so switching to them keeps the row mounted.
      if (worktreeState?.worktrees.some((w) => w.path === cwd)) return worktreeState.projectRoot;
      const match = allSessions.find((s) => s.cwd === cwd);
      return match?.projectRoot ?? cwd;
    },
    [worktreeState, allSessions],
  );

  // Notify parent only when the effective cwd actually changes (not when
  // projectRootFor identity changes due to session/worktree refreshes).
  const lastNotifiedCwdRef = useRef<string | null>(null);
  useEffect(() => {
    if (lastNotifiedCwdRef.current === selectedCwd) return;
    lastNotifiedCwdRef.current = selectedCwd;
    onCwdChange?.(selectedCwd, projectRootFor(selectedCwd));
  }, [selectedCwd, onCwdChange, projectRootFor]);

  // Sync the worktree switcher to the selected session's cwd. Sessions of all
  // worktrees in a project share one list, so clicking a session from another
  // worktree should move the effective cwd there. Only fires when the prop
  // value changes, so a manual switcher change is not snapped back.
  const lastSyncedCwdPropRef = useRef<string | null>(null);
  useEffect(() => {
    if (selectedCwdProp && selectedCwdProp !== lastSyncedCwdPropRef.current) {
      lastSyncedCwdPropRef.current = selectedCwdProp;
      setSelectedCwd(selectedCwdProp);
    }
  }, [selectedCwdProp]);

  // Load worktrees for the current effective cwd
  const [wtRefreshKey, setWtRefreshKey] = useState(0);
  useLayoutEffect(() => {
    if (!selectedCwd) {
      setWorktreeState(null);
      setWorktreeLoadingCwd(null);
      return;
    }
    let cancelled = false;
    setWorktreeLoadingCwd(selectedCwd);
    void import("@/lib/api-client")
      .then(({ call }) => call("worktrees.list", { projectRoot: selectedCwd }))
      .then((d) => {
        if (cancelled) return;
        setWorktreeLoadingCwd(null);
        setWorktreeState({
          forCwd: selectedCwd,
          projectRoot: d.projectRoot,
          isGit: d.isGit,
          isTopLevel: d.isTopLevel,
          worktrees: d.worktrees.map((worktree) => ({
            path: worktree.path,
            branch: worktree.branch ?? null,
            isMain: worktree.isMain === true,
          })),
        });
      })
      .catch(() => {
        if (!cancelled) {
          setWorktreeLoadingCwd(null);
          setWorktreeState(null);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [selectedCwd, wtRefreshKey, worktreesRefreshKey]);

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
  }, [allSessions, error, initialSessionId, loading, onInitialRestoreDone, onSelectSession, selectedCwd]);

  const commitCustomPath = useCallback(async () => {
    const path = customPathValue.trim();
    if (!path || customPathValidating) return;

    setCustomPathValidating(true);
    setCustomPathError(null);
    try {
      const result = await call("system.validateCwd", { path: path });
      if (!result.ok) {
        setCustomPathError(result.error ?? t("invalidDirectory", "Invalid directory"));
        return;
      }
      setSelectedCwd(result.path ?? path);
      setCustomPathOpen(false);
      setCustomPathValue("");
      setDropdownOpen(false);
    } catch (e) {
      setCustomPathError(e instanceof Error ? e.message : String(e));
    } finally {
      setCustomPathValidating(false);
    }
  }, [customPathValue, customPathValidating, t]);

  const handleDefaultCwd = useCallback(async () => {
    try {
      const data = await call("system.defaultCwd");
      if (data.cwd) {
        setSelectedCwd(data.cwd);
        setCustomPathOpen(false);
        setCustomPathValue("");
        setCustomPathError(null);
        setDropdownOpen(false);
      }
    } catch {
      // ignore
    }
  }, []);

  /** Desktop-native directory picker (design §6.1). Falls back to path input. */
  const handlePickDirectory = useCallback(async () => {
    try {
      const dir = await window.piBridge?.selectDirectory?.();
      if (!dir) return;
      const result = await call("system.validateCwd", { path: dir });
      if (!result.ok) {
        setCustomPathError(result.error ?? t("invalidDirectory", "Invalid directory"));
        return;
      }
      setSelectedCwd(result.path ?? dir);
      setCustomPathOpen(false);
      setCustomPathValue("");
      setCustomPathError(null);
      setDropdownOpen(false);
    } catch (e) {
      setCustomPathError(e instanceof Error ? e.message : String(e));
    }
  }, [t]);

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
      // Optimistically register the new worktree so projectRootFor() resolves
      // it to the main repo before the refetch lands (keeps AppShell from
      // treating the new cwd as a different project).
      setWorktreeState((prev) =>
        prev
          ? {
              ...prev,
              forCwd: worktree.path,
              worktrees: [...prev.worktrees, { path: worktree.path, branch, isMain: false }],
            }
          : prev,
      );
      setSelectedCwd(worktree.path);
      setWtRefreshKey((k) => k + 1);
    } catch (e) {
      setWtError(e instanceof Error ? e.message : String(e));
    } finally {
      setWtBusy(false);
    }
  }, [wtNewBranch, wtBusy, worktreeState]);

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
        setWtRefreshKey((k) => k + 1);
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
    [worktreeState, wtBusy, selectedCwd],
  );

  // Close dropdowns on outside click
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setDropdownOpen(false);
        setProjectFilter("");
        setCustomPathOpen(false);
        setCustomPathValue("");
        setCustomPathError(null);
      }
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

  // Clicking a session moves the effective cwd to that session's worktree.
  // Done on the click path (not via the selectedCwd prop sync) so it also
  // works when the prop value won't change — e.g. re-clicking the already
  // open session after manually switching worktrees.
  const handleSelectSessionFromList = useCallback(
    (s: SessionInfo) => {
      if (s.cwd) setSelectedCwd(s.cwd);
      onSelectSession(s);
    },
    [onSelectSession],
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

  const recentProjects = getRecentProjects(allSessions);
  const showProjectFilter = recentProjects.length > 8;
  const visibleProjects = projectFilter.trim()
    ? recentProjects.filter((p) => p.toLowerCase().includes(projectFilter.trim().toLowerCase()))
    : recentProjects;

  // Sessions of every worktree in the selected project are shown together.
  // Paths come from mixed sources (session files, git output) and may differ
  // in separators/casing on Windows, so compare with worktreePathsEqual.
  const selectedProject = projectRootFor(selectedCwd);
  const projectSessions = selectedProject
    ? allSessions.filter((s) => worktreePathsEqual(s.projectRoot ?? s.cwd, selectedProject))
    : allSessions;
  const filteredSessions = filterSessionsForQuery(projectSessions, sessionFilter);
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

        {/* CWD picker */}
        <div ref={dropdownRef} style={{ position: "relative" }}>
          <button
            onClick={() => setDropdownOpen((v) => !v)}
            title={selectedProject ?? selectedCwd ?? ""}
            style={{
              width: "100%",
              display: "flex",
              alignItems: "center",
              padding: "6px 10px",
              background: selectedCwd ? "var(--bg-hover)" : "var(--accent-soft)",
              border: selectedCwd ? "1px solid var(--border)" : "1px solid var(--accent-soft-border)",
              borderRadius: 7,
              cursor: "pointer",
              fontSize: 12,
              color: "var(--text)",
              textAlign: "left",
              transition: "border-color 0.15s, background 0.15s",
            }}
          >
            {selectedCwd ? (
              <PathLabel
                text={abbreviateHomePath(selectedProject ?? selectedCwd, homeDir)}
                style={{
                  flex: 1,
                  fontFamily: "var(--font-mono)",
                  fontSize: 11,
                  color: "var(--text)",
                }}
              />
            ) : (
              <span
                style={{
                  flex: 1,
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                  fontFamily: "var(--font-mono)",
                  fontSize: 11,
                  color: "var(--text-dim)",
                }}
              >
                {initialSessionId && !restoredRef.current ? "" : t("selectProjectEllipsis", "Select project…")}
              </span>
            )}
          </button>

          <AnimatedDropdown
            open={dropdownOpen}
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
            {showProjectFilter && (
              <div style={{ padding: "6px 8px", borderBottom: "1px solid var(--border)" }}>
                <input
                  value={projectFilter}
                  onChange={(e) => setProjectFilter(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Escape") {
                      setProjectFilter("");
                      setDropdownOpen(false);
                    }
                  }}
                  placeholder={t("filterProjects", "Filter projects…")}
                  autoFocus
                  style={{
                    width: "100%",
                    fontSize: 11,
                    fontFamily: "var(--font-mono)",
                    padding: "5px 8px",
                    border: "1px solid var(--border)",
                    borderRadius: 5,
                    outline: "none",
                    background: "var(--bg)",
                    color: "var(--text)",
                    boxSizing: "border-box",
                  }}
                />
              </div>
            )}
            <div style={{ maxHeight: "min(50vh, 380px)", overflowY: "auto" }}>
              {visibleProjects.map((project) => (
                <button
                  key={project}
                  onClick={() => {
                    setSelectedCwd(project);
                    setProjectFilter("");
                    setCustomPathOpen(false);
                    setCustomPathValue("");
                    setCustomPathError(null);
                    setDropdownOpen(false);
                  }}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 7,
                    width: "100%",
                    padding: "8px 10px",
                    background: "var(--bg)",
                    border: "none",
                    borderBottom: "1px solid var(--border)",
                    color: project === selectedProject ? "var(--text)" : "var(--text-muted)",
                    cursor: "pointer",
                    textAlign: "left",
                    fontSize: 11,
                    fontFamily: "var(--font-mono)",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                  title={project}
                >
                  {project === selectedProject && (
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
                  )}
                  {project !== selectedProject && <span style={{ width: 10, flexShrink: 0 }} />}
                  <PathLabel text={abbreviateHomePath(project, homeDir)} style={{ flex: 1 }} />
                </button>
              ))}
              {visibleProjects.length === 0 && projectFilter.trim() && (
                <div style={{ padding: "8px 10px", fontSize: 11, color: "var(--text-dim)" }}>
                  {t("noMatchingProjects", "No matching projects")}
                </div>
              )}
            </div>

            {/* Default cwd shortcut */}
            {!customPathOpen && (
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  void handleDefaultCwd();
                }}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 7,
                  width: "100%",
                  padding: "8px 10px",
                  background: "none",
                  border: "none",
                  borderTop: visibleProjects.length > 0 ? "1px solid var(--border)" : "none",
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
                  strokeLinejoin="round"
                  style={{ flexShrink: 0 }}
                >
                  <path d="M1 3A1 1 0 0 1 2 2H4L5 3.5H8.5a.5.5 0 0 1 .5.5v4a.5.5 0 0 1-.5.5h-7A.5.5 0 0 1 1 8V3Z" />
                </svg>
                <span>{t("useDefaultDirectory", "Use default directory")}</span>
              </button>
            )}

            {/* Native directory picker (desktop) */}
            {!customPathOpen && typeof window !== "undefined" && !!window.piBridge && (
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  void handlePickDirectory();
                }}
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
                  strokeLinejoin="round"
                  style={{ flexShrink: 0 }}
                >
                  <path d="M1 3A1 1 0 0 1 2 2H4L5 3.5H8.5a.5.5 0 0 1 .5.5v4a.5.5 0 0 1-.5.5h-7A.5.5 0 0 1 1 8V3Z" />
                </svg>
                <span>{t("browseFolder", "Browse folder…")}</span>
              </button>
            )}

            {/* Custom path entry */}
            {!customPathOpen ? (
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  setCustomPathOpen(true);
                  setCustomPathError(null);
                  deferFocus(() => customPathInputRef.current?.focus());
                }}
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
                <span>{t("customPath", "Custom path…")}</span>
              </button>
            ) : (
              <div style={{ padding: "6px 8px", borderTop: visibleProjects.length > 0 ? "none" : undefined }}>
                <input
                  ref={customPathInputRef}
                  value={customPathValue}
                  onChange={(e) => {
                    setCustomPathValue(e.target.value);
                    setCustomPathError(null);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      void commitCustomPath();
                    }
                    if (e.key === "Escape") {
                      setCustomPathOpen(false);
                      setCustomPathValue("");
                      setCustomPathError(null);
                    }
                  }}
                  placeholder="/path/to/project"
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
                {customPathError && (
                  <div
                    style={{
                      marginTop: 5,
                      color: "#dc2626",
                      fontSize: 11,
                      lineHeight: 1.35,
                      overflowWrap: "anywhere",
                    }}
                  >
                    {customPathError}
                  </div>
                )}
                <div style={{ display: "flex", gap: 5, marginTop: 5 }}>
                  <button
                    onClick={() => void commitCustomPath()}
                    disabled={customPathValidating || !customPathValue.trim()}
                    style={{
                      flex: 1,
                      padding: "4px 0",
                      background: "var(--accent)",
                      border: "none",
                      borderRadius: 5,
                      color: "#fff",
                      fontSize: 11,
                      fontWeight: 600,
                      cursor: customPathValidating || !customPathValue.trim() ? "not-allowed" : "pointer",
                      opacity: customPathValidating || !customPathValue.trim() ? 0.65 : 1,
                    }}
                  >
                    {customPathValidating ? t("checking", "Checking…") : t("open", "Open")}
                  </button>
                  <button
                    onClick={() => {
                      setCustomPathOpen(false);
                      setCustomPathValue("");
                      setCustomPathError(null);
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
          </AnimatedDropdown>
        </div>

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
