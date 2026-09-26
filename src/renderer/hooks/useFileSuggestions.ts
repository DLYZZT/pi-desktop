import { useEffect, useMemo, useRef, useState } from "react";
import { fileIndex } from "@/lib/api-client";
import { LatestAbortableRequest } from "@/lib/latest-abortable-request";
import type { AtQueryMatch, FileIndexEntry } from "@/lib/file-fuzzy";
import {
  FileSuggestionLruCache,
  fileSuggestionCacheKey,
  projectFileSuggestionResponse,
  type FileSuggestionDegradedReason,
} from "@/lib/file-suggestion-client";

/** Owns candidate reads and cache; the composer owns caret and menu interaction. */
export function useFileSuggestions(cwd: string | null | undefined, atQuery: AtQueryMatch | null) {
  const [atSuggestionState, setAtSuggestionState] = useState<{
    cwd: string;
    tokenKey: string;
    query: string;
    matches: FileIndexEntry[];
    truncated: boolean;
    degradedReason?: FileSuggestionDegradedReason;
    status: "loading" | "ready" | "error";
  } | null>(null);
  const fileSuggestionCacheRef = useRef(new FileSuggestionLruCache());
  const fileSuggestionRequestRef = useRef(new LatestAbortableRequest());
  const atQueryText = atQuery?.query ?? null;
  const atTokenKey = atQuery === null ? null : `${atQuery.start}:${atQuery.quoted ? 1 : 0}:${atQuery.query}`;
  // Request candidates for the active token. Empty queries and directory
  // drill-down browse immediately; non-empty searches debounce briefly. The
  // request generation and token tag both prevent stale responses from
  // replacing a newer query.
  useEffect(() => {
    if (atTokenKey === null || atQueryText === null || !cwd) {
      fileSuggestionRequestRef.current.cancel();
      setAtSuggestionState(null);
      return;
    }
    const fetchCwd = cwd;
    const query = atQueryText;
    const tokenKey = atTokenKey;
    const platform = window.piBridge?.platform ?? "linux";
    const cacheKey = fileSuggestionCacheKey(fetchCwd, query, platform);
    const cached = fileSuggestionCacheRef.current.get(cacheKey);
    if (cached) {
      setAtSuggestionState({ cwd: fetchCwd, tokenKey, query, ...cached, status: "ready" });
      return;
    }

    setAtSuggestionState({ cwd: fetchCwd, tokenKey, query, matches: [], truncated: false, status: "loading" });
    const requests = fileSuggestionRequestRef.current;
    let generation: number | null = null;
    const timer = setTimeout(
      () => {
        const request = requests.begin();
        generation = request.generation;
        // The RPC has no backend cancellation method. The existing request
        // token invalidates local results when the query or workspace changes.
        fileIndex(fetchCwd, query)
          .then((data) => {
            if (!requests.isCurrent(request.generation)) return;
            const snapshot = projectFileSuggestionResponse(data, query);
            fileSuggestionCacheRef.current.setWithTtl(
              cacheKey,
              snapshot,
              query === "" || query.endsWith("/") ? 2_000 : 1_000,
            );
            setAtSuggestionState({ cwd: fetchCwd, tokenKey, query, ...snapshot, status: "ready" });
          })
          .catch((error) => {
            if (!requests.isCurrent(request.generation) || (error as { name?: string })?.name === "AbortError") return;
            setAtSuggestionState({
              cwd: fetchCwd,
              tokenKey,
              query,
              matches: [],
              truncated: false,
              status: "error",
            });
          })
          .finally(() => requests.finish(request.generation));
      },
      query === "" || query.endsWith("/") ? 0 : 150,
    );
    return () => {
      clearTimeout(timer);
      if (generation !== null) requests.cancel(generation);
    };
  }, [atTokenKey, atQueryText, cwd]);

  const suggestionStateInUse =
    atSuggestionState !== null && atSuggestionState.cwd === cwd && atSuggestionState.tokenKey === atTokenKey;
  const activeSuggestionState = suggestionStateInUse ? atSuggestionState : null;
  const atMatches: FileIndexEntry[] = useMemo(() => activeSuggestionState?.matches ?? [], [activeSuggestionState]);

  return { tokenKey: atTokenKey, state: activeSuggestionState, matches: atMatches };
}
