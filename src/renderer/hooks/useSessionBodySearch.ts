import { useEffect, useState } from "react";
import type { SessionInfo } from "@/lib/types";
import { call } from "@/lib/api-client";

type Results = {
  scope: SessionInfo[];
  query: string;
  matches: Map<string, string>;
  pending: boolean;
  incomplete: boolean;
};
const empty = new Map<string, string>();
export function useSessionBodySearch(sessions: SessionInfo[], value: string, enabled: boolean) {
  const query = enabled ? value.trim() : "";
  const [results, setResults] = useState<Results>();
  useEffect(() => {
    if (!query) return;
    let active = true;
    const search = async () => {
      const ids = sessions.map((s) => s.id);
      const matches = new Map<string, string>();
      let incomplete = false;
      try {
        for (let i = 0; active && i < ids.length; i += 8) {
          const batch = await call("sessions.searchMessages", { ids: ids.slice(i, i + 8), query });
          if (!active) return;
          incomplete ||= batch.unreadable > 0;
          for (const item of batch.matches) matches.set(item.id, item.snippet);
          if (i + 8 < ids.length)
            setResults({ scope: sessions, query, matches: new Map(matches), pending: true, incomplete });
        }
      } catch {
        incomplete = true;
      }
      if (active) setResults({ scope: sessions, query, matches, pending: false, incomplete });
    };
    const timer = setTimeout(() => void search(), 250);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [sessions, query]);
  if (query && results?.scope === sessions && results.query === query) return results;
  return { matches: empty, pending: Boolean(query), incomplete: false };
}
