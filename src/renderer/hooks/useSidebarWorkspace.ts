import { useState, useEffect, useLayoutEffect, useCallback, useRef } from "react";
import { call } from "@/lib/api-client";
import type { SessionInfo } from "@/lib/types";

interface WorktreeEntry {
  path: string;
  branch: string | null;
  isMain: boolean;
}

export type { WorktreeEntry };

export interface WorktreeState {
  /** The cwd this data was fetched for — guards against stale responses */
  forCwd: string;
  projectRoot: string;
  isGit: boolean;
  /** False when forCwd is a repo subdirectory — the switcher is hidden there
   *  because subdir sessions keep their own project identity */
  isTopLevel: boolean;
  worktrees: WorktreeEntry[];
}

/** Worktree facts for one project, fetched independently of the active cwd. */
export interface ProjectWorktreeInfo {
  /** Resolved repo root as reported by git (may differ from the requested path). */
  projectRoot: string;
  isGit: boolean;
  isTopLevel: boolean;
  worktrees: WorktreeEntry[];
}

// Pure list helpers live with the other session-list logic; re-exported here
// for the sidebar's existing import sites.
export { getRecentProjects } from "@/lib/session-list";

/** Own the effective directory and the project/worktree data used by the sidebar. */
export function useSidebarWorkspace({
  allSessions,
  selectedCwd: selectedCwdProp,
  onCwdChange,
  worktreesRefreshKey,
  projectInfoRevision,
}: {
  allSessions: SessionInfo[];
  selectedCwd?: string | null;
  onCwdChange?: (cwd: string | null, projectRoot?: string | null) => void;
  worktreesRefreshKey?: number;
  projectInfoRevision: number;
}) {
  const [selectedCwd, setSelectedCwd] = useState<string | null>(null);
  const [homeDir, setHomeDir] = useState<string>("");
  const [worktreeState, setWorktreeState] = useState<WorktreeState | null>(null);
  const [worktreeLoadingCwd, setWorktreeLoadingCwd] = useState<string | null>(null);
  useEffect(() => {
    call("system.home")
      .then((d: { home?: string }) => {
        if (d.home) setHomeDir(d.home);
      })
      .catch(() => {});
  }, []);

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

  // Metadata reconciliation updates grouping without treating it as directory
  // navigation or remounting the active chat.
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
  // Aggregated mode shows every project at once, so worktree facts are cached
  // per project instead of only for the active cwd. Failed lookups are not
  // cached, letting a later retry (e.g. after roots are allowed) succeed.
  const projectWorktreesRef = useRef<Map<string, ProjectWorktreeInfo>>(new Map());
  const projectWorktreesInflightRef = useRef<Map<string, Promise<ProjectWorktreeInfo | null>>>(new Map());
  const [projectWorktreesRevision, setProjectWorktreesRevision] = useState(0);

  const invalidateProjectWorktrees = useCallback(() => {
    projectWorktreesRef.current.clear();
    setProjectWorktreesRevision((revision) => revision + 1);
  }, []);

  const getProjectWorktrees = useCallback(
    (projectRoot: string): ProjectWorktreeInfo | null => projectWorktreesRef.current.get(projectRoot) ?? null,
    [],
  );

  const ensureProjectWorktrees = useCallback(async (projectRoot: string): Promise<ProjectWorktreeInfo | null> => {
    const cached = projectWorktreesRef.current.get(projectRoot);
    if (cached) return cached;
    const inflight = projectWorktreesInflightRef.current.get(projectRoot);
    if (inflight) return inflight;
    const request = (async () => {
      try {
        const { call } = await import("@/lib/api-client");
        const d = await call("worktrees.list", { projectRoot });
        const info: ProjectWorktreeInfo = {
          projectRoot: d.projectRoot,
          isGit: d.isGit,
          isTopLevel: d.isTopLevel,
          worktrees: d.worktrees.map((worktree) => ({
            path: worktree.path,
            branch: worktree.branch ?? null,
            isMain: worktree.isMain === true,
          })),
        };
        projectWorktreesRef.current.set(projectRoot, info);
        setProjectWorktreesRevision((revision) => revision + 1);
        return info;
      } catch {
        return null;
      } finally {
        projectWorktreesInflightRef.current.delete(projectRoot);
      }
    })();
    projectWorktreesInflightRef.current.set(projectRoot, request);
    return request;
  }, []);

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
  }, [selectedCwd, wtRefreshKey, worktreesRefreshKey, projectInfoRevision]);

  const registerCreatedWorktree = useCallback(
    (worktreePath: string, branch: string) => {
      // Optimistically register the new worktree so projectRootFor() resolves
      // it to the main repo before the refetch lands (keeps AppShell from
      // treating the new cwd as a different project).
      setWorktreeState((prev) =>
        prev
          ? {
              ...prev,
              forCwd: worktreePath,
              worktrees: [...prev.worktrees, { path: worktreePath, branch, isMain: false }],
            }
          : prev,
      );
      setSelectedCwd(worktreePath);
      invalidateProjectWorktrees();
      setWtRefreshKey((k) => k + 1);
    },
    [invalidateProjectWorktrees],
  );
  const refreshWorktrees = useCallback(() => {
    invalidateProjectWorktrees();
    setWtRefreshKey((key) => key + 1);
  }, [invalidateProjectWorktrees]);
  return {
    selectedCwd,
    setSelectedCwd,
    selectedProject: projectRootFor(selectedCwd),
    homeDir,
    worktreeState,
    worktreeLoadingCwd,
    registerCreatedWorktree,
    refreshWorktrees,
    projectWorktreesRevision,
    getProjectWorktrees,
    ensureProjectWorktrees,
  };
}
