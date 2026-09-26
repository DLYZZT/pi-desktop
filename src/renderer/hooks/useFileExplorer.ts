import { useCallback, useEffect, useRef, useState } from "react";
import { DirectoryRefreshCoordinator } from "@/lib/directory-refresh";
import { readDirectory, type DirectoryData, type FileExplorerTranslate } from "@/lib/file-explorer-data";
import { watchFile } from "@/lib/file-watch-client";

interface DirectoryState extends DirectoryData {
  path: string;
  directory: boolean;
  loaded: boolean;
  stale: boolean;
  loading: boolean;
  error: string | null;
  revision: number;
}
function initialState(path: string, directory: boolean, open: boolean): DirectoryState {
  return {
    path,
    directory,
    entries: [],
    gitStatus: null,
    loaded: !directory,
    stale: directory,
    loading: directory && open,
    error: null,
    revision: 0,
  };
}

/** Owns a directory listing; expanded state stays with the tree's workspace. */
export function useDirectoryListing({
  path,
  directory,
  open,
  revision,
  includeGit = false,
  t,
}: {
  path: string;
  directory: boolean;
  open: boolean;
  revision?: number;
  includeGit?: boolean;
  t: FileExplorerTranslate;
}) {
  const [state, setState] = useState(() => initialState(path, directory, open));
  const currentOpen = useRef(open);
  currentOpen.current = open;
  const currentRevision = useRef(revision);
  currentRevision.current = revision;
  const scopeRef = useRef<{ queue: DirectoryRefreshCoordinator<DirectoryData>; revision?: number } | null>(null);

  useEffect(() => {
    setState((previous) =>
      previous.path === path && previous.directory === directory
        ? previous
        : initialState(path, directory, currentOpen.current),
    );
    if (!directory) return;
    const queue = new DirectoryRefreshCoordinator({
      read: () => readDirectory(path, t, includeGit),
      apply: (data) =>
        setState((previous) => ({
          ...previous,
          ...data,
          path,
          directory,
          loaded: true,
          stale: false,
          error: null,
          revision: previous.revision + 1,
        })),
      onError: (error) =>
        setState((previous) => ({ ...previous, error: error instanceof Error ? error.message : String(error) })),
      onLoading: (loading) => setState((previous) => ({ ...previous, loading, ...(loading ? { error: null } : {}) })),
      onInvalidate: () => setState((previous) => ({ ...previous, stale: true })),
    });
    const scope = { queue, revision: currentRevision.current };
    scopeRef.current = scope;
    void queue.setEnabled(currentOpen.current);
    return () => {
      queue.dispose();
      if (scopeRef.current === scope) scopeRef.current = null;
    };
  }, [path, directory, includeGit, t]);

  useEffect(() => {
    void scopeRef.current?.queue.setEnabled(open);
  }, [open]);
  useEffect(() => {
    const scope = scopeRef.current;
    if (!scope || scope.revision === revision) return;
    scope.revision = revision;
    void scope.queue.invalidate();
  }, [revision]);

  const invalidate = useCallback(() => {
    void scopeRef.current?.queue.invalidate();
  }, []);
  return {
    ...(state.path === path && state.directory === directory ? state : initialState(path, directory, open)),
    invalidate,
  };
}

/** Root entries and Git status share one refresh cycle and one watch debounce. */
export function useFileExplorer(cwd: string, refreshKey: number | undefined, t: FileExplorerTranslate) {
  const listing = useDirectoryListing({ path: cwd, directory: true, open: true, includeGit: true, t });
  const { invalidate } = listing;
  const [watching, setWatching] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const requestedRefresh = useRef({ cwd, refreshKey });
  const refresh = useCallback(() => {
    if (timerRef.current !== null) clearTimeout(timerRef.current);
    timerRef.current = null;
    invalidate();
  }, [invalidate]);

  useEffect(() => {
    const previous = requestedRefresh.current;
    requestedRefresh.current = { cwd, refreshKey };
    if (previous.cwd === cwd && previous.refreshKey !== refreshKey) refresh();
  }, [cwd, refreshKey, refresh]);

  useEffect(() => {
    let active = true;
    setWatching(false);
    const stop = watchFile(cwd, {
      onStatus: setWatching,
      onChange: () => {
        if (timerRef.current !== null) clearTimeout(timerRef.current);
        timerRef.current = setTimeout(() => {
          timerRef.current = null;
          if (active) refresh();
        }, 200);
      },
    });
    return () => {
      active = false;
      if (timerRef.current !== null) clearTimeout(timerRef.current);
      timerRef.current = null;
      stop();
    };
  }, [cwd, refresh]);
  return { ...listing, watching };
}
