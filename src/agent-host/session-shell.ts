import { useAgentShell, type AgentShell } from "../shared/agent-shell.ts";
import { PRESET_DEFAULT } from "../shared/tool-presets.ts";
import { agentShellPreferences } from "./agent-shell-settings.ts";
import type { SessionManager } from "@earendil-works/pi-coding-agent";
import { getDefaultStore } from "./session-tool-store.ts";
import { getLegacySessionToolNames } from "./legacy-session-tools.ts";
import { canonicalPathForComparison } from "./directory-validation.ts";
import { sessionIndex } from "./session-index.ts";
import path from "node:path";
import { realpathSync } from "node:fs";
import { readSessionFileHeader } from "./session-readonly.ts";
import { directoryForkWorkspaceRoot } from "./desktop-data-root.ts";

function forkScope(header: ReturnType<SessionManager["getHeader"]>) {
  if (typeof header?.parentSession !== "string" || !header.parentSession) return "ordinary";
  if ("piDesktopFork" in header && header.piDesktopFork === "directory") return "marked";
  const parent = header.parentSession,
    root = sessionIndex.sessionsRoot();
  if (!path.isAbsolute(parent) || !parent.endsWith(".jsonl")) return "unknown";
  const previouslyKnown = () =>
    header.cwd && getDefaultStore().knowsSameDirectoryBranch(header.id, header.cwd, parent) ? "same" : "unknown";
  if (path.resolve(parent).startsWith(directoryForkWorkspaceRoot() + path.sep)) return "unknown";
  try {
    const canonicalRoot = realpathSync(root);
    let relative = path.relative(root, parent);
    if (path.isAbsolute(relative) || relative.split(path.sep).includes(".."))
      relative = path.relative(canonicalRoot, parent);
    if (path.isAbsolute(relative) || relative.split(path.sep).includes("..")) return previouslyKnown();
    const canonical = realpathSync(parent);
    if (path.relative(path.join(canonicalRoot, relative), canonical) !== "") return "unknown";
    const cwd = readSessionFileHeader(canonical)?.cwd;
    if (cwd && header.cwd)
      return canonicalPathForComparison(cwd) === canonicalPathForComparison(header.cwd) ? "same" : "directory";
  } catch {
    /* Missing, inaccessible and unrecognized parents cannot establish the branch's scope. */
  }
  return previouslyKnown();
}

export function forkNeedsOwnToolSelection(header: ReturnType<SessionManager["getHeader"]>): boolean {
  const scope = forkScope(header);
  return scope !== "ordinary" && scope !== "same";
}

/** Desktop settings take priority; shared JSONL is read only for one-way legacy migration. */
export async function loadSessionToolSelection(
  manager: Pick<SessionManager, "getSessionId" | "getEntries" | "getHeader">,
  isNew: boolean,
  requested?: string[],
  writable = false,
) {
  const store = getDefaultStore(),
    id = manager.getSessionId(),
    header = manager.getHeader();
  const read = (remember: boolean) => {
    const saved = store.get(id);
    const scope = saved === undefined ? forkScope(header) : "ordinary";
    const directoryFork = scope !== "ordinary" && scope !== "same";
    if (remember && scope === "same" && header?.parentSession)
      store.locked.rememberLegacyFork(id, { cwd: header.cwd, parentSession: header.parentSession });
    if (remember && (scope === "unknown" || scope === "directory")) store.locked.rememberLegacyFork(id);
    const latest = store.get(id);
    const names = latest ?? (directoryFork ? [] : (getLegacySessionToolNames(manager) ?? requested));
    return {
      ...selectSessionShell({ isNew, storedShell: store.getShell(id), toolNames: names }),
      persistSelection: latest === undefined && !directoryFork,
    };
  };
  const legacyBranch = header?.parentSession && !("piDesktopFork" in header && header.piDesktopFork === "directory");
  return writable && legacyBranch ? store.writeLock.run(() => read(true)) : read(false);
}

export function selectSessionShell({
  isNew,
  storedShell,
  toolNames,
  platform = process.platform,
  readDefault = () => agentShellPreferences().get().shell,
}: {
  isNew: boolean;
  storedShell?: AgentShell;
  toolNames?: string[];
  platform?: string;
  readDefault?: () => AgentShell;
}): { shell?: AgentShell; toolNames?: string[] } {
  // Restoring legacy sessions, including dual-shell grants, must not adopt a
  // later global preference. No-tools sessions still remember their executor.
  const shell = platform === "win32" ? (storedShell ?? (isNew ? readDefault() : undefined)) : undefined;
  const names = toolNames ?? (shell ? PRESET_DEFAULT : undefined);
  return { shell, toolNames: names === undefined ? undefined : useAgentShell(names, shell) };
}
