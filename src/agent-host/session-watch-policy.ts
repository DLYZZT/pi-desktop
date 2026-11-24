import path from "node:path";
import { directoryForkWorkspaceRoot } from "./desktop-data-root.ts";

export type SessionWatchChange = { kind: "ignore" } | { kind: "refresh-all" } | { kind: "refresh-path"; path: string };

export function classifySessionWatchChange(
  agentDir: string,
  sessionsRoot: string,
  filename: string | Buffer | null,
): SessionWatchChange {
  if (!filename) return { kind: "refresh-all" };
  const name = filename.toString();
  const resolvedAgentDir = path.resolve(agentDir);
  const candidate = path.resolve(resolvedAgentDir, name);
  const privateForks = directoryForkWorkspaceRoot();
  if (candidate === privateForks || candidate.startsWith(privateForks + path.sep)) return { kind: "ignore" };
  if (candidate !== resolvedAgentDir && !candidate.startsWith(`${resolvedAgentDir}${path.sep}`))
    return { kind: "ignore" };
  const resolvedSessionsRoot = path.resolve(sessionsRoot);
  if (candidate.endsWith(".jsonl") && candidate.startsWith(`${resolvedSessionsRoot}${path.sep}`)) {
    return { kind: "refresh-path", path: candidate };
  }
  if (name.endsWith(".json") || name.includes("session")) return { kind: "refresh-all" };
  return { kind: "ignore" };
}
