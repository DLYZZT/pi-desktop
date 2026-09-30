import { useEffect, useState } from "react";
import type { SlashCommandInfo } from "@contract/agent-commands";

/** Results belong to an exact input; stale suggestions must never consume Enter. */
export function useSlashArguments(
  value: string,
  load?: (input?: string) => Promise<SlashCommandInfo[]> | SlashCommandInfo[],
) {
  const topLevel = value.startsWith("/") && !/\s/.test(value.slice(1));
  useEffect(() => {
    if (topLevel && load) void Promise.resolve(load()).catch(() => {});
  }, [topLevel, load]);
  const argumentMode = /^\/\S+ /.test(value) && !value.includes("\n");
  const [result, setResult] = useState<{ input: string; items: SlashCommandInfo[] } | null>(null);
  useEffect(() => {
    if (!argumentMode || !load) return;
    let current = true;
    const timer = setTimeout(() => {
      Promise.resolve(load(value)).then(
        (items) => {
          if (current) setResult({ input: value, items });
        },
        () => {
          if (current) setResult({ input: value, items: [] });
        },
      );
    }, 100);
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [argumentMode, value, load]);
  return {
    argumentMode,
    items: result?.input === value ? result.items.filter((item) => `/${item.name}` !== value.trimEnd()) : [],
  };
}
