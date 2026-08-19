import { useCallback, useMemo, useState } from "react";
import type { SessionInfo } from "@/lib/types";
import { filterSessionsForSidebar, projectFoldersForSidebar } from "./sessions";

const GROUP_KEY = "pi-fork-group-by-project";
const COLLAPSED_KEY = "pi-fork-collapsed-projects";

function readFlag(key: string, fallback: boolean): boolean {
  if (typeof window === "undefined") return fallback;
  try {
    const raw = window.localStorage.getItem(key);
    if (raw === null) return fallback;
    return raw === "1";
  } catch {
    return fallback;
  }
}

function readCollapsed(): Set<string> {
  if (typeof window === "undefined") return new Set();
  try {
    const raw = window.localStorage.getItem(COLLAPSED_KEY);
    if (!raw) return new Set();
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? new Set(parsed.filter((item) => typeof item === "string")) : new Set();
  } catch {
    return new Set();
  }
}

function writeCollapsed(next: Set<string>): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...next]));
  } catch {
    /* ignore */
  }
}

export function useForkSessionList(allSessions: SessionInfo[], sessionFilter: string) {
  const [listScope, setListScope] = useState<string | null>(null);
  const [archivedOpen, setArchivedOpen] = useState(false);
  const [groupByProject, setGroupByProjectState] = useState(() => readFlag(GROUP_KEY, true));
  const [collapsedProjects, setCollapsedProjects] = useState(readCollapsed);
  const filteredSessions = useMemo(
    () =>
      filterSessionsForSidebar(allSessions, {
        archived: false,
        projectRoot: listScope,
        query: sessionFilter,
      }),
    [allSessions, listScope, sessionFilter],
  );
  const archivedSessions = useMemo(
    () =>
      filterSessionsForSidebar(allSessions, {
        archived: true,
        projectRoot: listScope,
      }),
    [allSessions, listScope],
  );
  const projectFolders = useMemo(
    () => (groupByProject && !listScope ? projectFoldersForSidebar(allSessions, sessionFilter) : []),
    [allSessions, groupByProject, listScope, sessionFilter],
  );
  const setGroupByProject = useCallback((enabled: boolean) => {
    setGroupByProjectState(enabled);
    try {
      window.localStorage.setItem(GROUP_KEY, enabled ? "1" : "0");
    } catch {
      /* ignore */
    }
  }, []);
  const toggleProjectFolder = useCallback((root: string) => {
    setCollapsedProjects((prev) => {
      const next = new Set(prev);
      if (next.has(root)) next.delete(root);
      else next.add(root);
      writeCollapsed(next);
      return next;
    });
  }, []);
  return {
    listScope,
    setListScope,
    archivedOpen,
    setArchivedOpen,
    filteredSessions,
    archivedSessions,
    groupByProject: groupByProject && !listScope,
    setGroupByProject,
    projectFolders,
    collapsedProjects,
    toggleProjectFolder,
    showProjectTag: !listScope && !(groupByProject && !listScope),
  };
}
