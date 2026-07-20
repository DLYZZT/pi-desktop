import fs from "node:fs";
import path from "node:path";
import type { ManagedComponentId, ToolCapabilityId } from "../../shared/toolchains/types.ts";

const MAX_VISITED_ENTRIES = 20_000;
const MAX_DEPTH = 10;

interface EntrypointDefinition {
  capability: ToolCapabilityId;
  names: readonly string[];
  preferredSuffixes?: readonly string[];
}

const COMPONENT_ENTRYPOINTS: Record<ManagedComponentId, readonly EntrypointDefinition[]> = {
  "node-lts": [{ capability: "js.node", names: ["node.exe", "node"], preferredSuffixes: ["bin/node"] }],
  cpython: [{ capability: "python.interpreter", names: ["python.exe", "python3.14", "python3", "python"] }],
  uv: [{ capability: "python.uv", names: ["uv.exe", "uv"] }],
  "portable-git": [
    { capability: "vcs.git", names: ["git.exe", "git"], preferredSuffixes: ["cmd/git.exe"] },
    { capability: "shell.bash", names: ["bash.exe", "bash"], preferredSuffixes: ["bin/bash.exe"] },
  ],
  ripgrep: [{ capability: "search.rg", names: ["rg.exe", "rg"] }],
  fd: [{ capability: "search.fd", names: ["fd.exe", "fd"] }],
  jq: [{ capability: "data.jq", names: ["jq.exe", "jq"] }],
  bun: [{ capability: "js.bun", names: ["bun.exe", "bun"] }],
};

function findEntrypoint(runtimeRoot: string, definition: EntrypointDefinition): string {
  const names = new Set(definition.names);
  const candidates: Array<{ path: string; score: number }> = [];
  const queue: Array<{ directory: string; depth: number }> = [{ directory: runtimeRoot, depth: 0 }];
  let visited = 0;
  const canonicalRoot = fs.realpathSync.native(runtimeRoot);

  while (queue.length > 0 && visited < MAX_VISITED_ENTRIES) {
    const current = queue.shift()!;
    let entries: fs.Dirent[];
    try {
      entries = fs
        .readdirSync(current.directory, { withFileTypes: true })
        .sort((left, right) => left.name.localeCompare(right.name, "en"));
    } catch {
      continue;
    }
    for (const entry of entries) {
      visited += 1;
      if (visited > MAX_VISITED_ENTRIES) break;
      const absolute = path.join(current.directory, entry.name);
      if (entry.isDirectory() && current.depth < MAX_DEPTH) {
        queue.push({ directory: absolute, depth: current.depth + 1 });
        continue;
      }
      if (!names.has(entry.name.toLowerCase())) continue;
      try {
        const stats = fs.statSync(absolute);
        if (!stats.isFile()) continue;
        const real = fs.realpathSync.native(absolute);
        if (real !== canonicalRoot && !real.startsWith(`${canonicalRoot}${path.sep}`)) continue;
        const relative = path.relative(runtimeRoot, absolute).split(path.sep);
        const normalizedRelative = relative.join("/").toLowerCase();
        const preferredPriority = definition.preferredSuffixes?.findIndex((suffix) =>
          normalizedRelative.endsWith(suffix.toLowerCase()),
        );
        const preferredBonus =
          preferredPriority !== undefined && preferredPriority >= 0 ? -1_000 + preferredPriority : 0;
        const namePriority = definition.names.indexOf(entry.name.toLowerCase());
        const binBonus = relative.some((segment) => segment.toLowerCase() === "bin") ? -100 : 0;
        candidates.push({
          path: absolute,
          score: relative.length * 10 + Math.max(0, namePriority) + binBonus + preferredBonus,
        });
      } catch {
        // Ignore broken links and inaccessible files.
      }
    }
  }

  candidates.sort((left, right) => left.score - right.score || left.path.localeCompare(right.path, "en"));
  const executable = candidates[0]?.path;
  if (!executable) throw new Error(`Managed archive does not contain ${definition.capability}`);
  return executable;
}

export function findComponentEntrypoints(
  componentId: ManagedComponentId,
  runtimeRoot: string,
): Array<{ capability: ToolCapabilityId; executable: string }> {
  return COMPONENT_ENTRYPOINTS[componentId].map((definition) => ({
    capability: definition.capability,
    executable: findEntrypoint(runtimeRoot, definition),
  }));
}

export function findComponentEntrypoint(
  componentId: ManagedComponentId,
  runtimeRoot: string,
): { capability: ToolCapabilityId; executable: string } {
  return findComponentEntrypoints(componentId, runtimeRoot)[0]!;
}
