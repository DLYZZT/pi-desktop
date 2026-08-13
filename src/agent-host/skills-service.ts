/**
 * Skills search / install via skills.sh API or ELECTRON_RUN_AS_NODE npx.
 */
import { runNpx } from "./npx";
import type { SkillSearchResult } from "../shared/api-types";
import { ToolchainError } from "../shared/toolchains/errors.ts";
import { buildSkillsCliArgs } from "./skills-cli.ts";
import { normalizeSkillsApiResults, parseSkillsSearchOutput } from "./skills-search.ts";

const ANSI_RE = /\x1B\[[0-9;]*m/g;
const SEARCH_API_BASE = process.env.SKILLS_API_URL || "https://skills.sh";

async function searchSkillsApi(query: string, limit: number): Promise<SkillSearchResult[]> {
  const url = `${SEARCH_API_BASE}/api/search?q=${encodeURIComponent(query)}&limit=${limit}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`skills.sh search failed: HTTP ${res.status}`);
  const data = (await res.json()) as {
    skills?: Array<{ id?: string; name?: string; source?: string; installs?: number }>;
  };
  return normalizeSkillsApiResults(data.skills ?? [], SEARCH_API_BASE);
}

export async function searchSkills(query: string, limit = 50): Promise<{ results: SkillSearchResult[] }> {
  const q = query.trim();
  if (!q) return { results: [] };
  const capped = Math.min(50, Math.max(1, limit));

  try {
    const results = await searchSkillsApi(q, capped);
    return { results };
  } catch {
    const { stdout, stderr } = await runNpx(buildSkillsCliArgs(["find", q]), {
      timeout: 60_000,
      env: { FORCE_COLOR: "0" },
    });
    return { results: parseSkillsSearchOutput(stdout + stderr).slice(0, capped) };
  }
}

export async function installSkill(params: {
  package: string;
  scope?: "global" | "project";
  cwd?: string;
}): Promise<{ ok: true; output: string }> {
  const pkg = params.package?.trim();
  if (!pkg) throw new Error("package required");

  const isGlobal = params.scope !== "project";
  const args = buildSkillsCliArgs(["add", pkg, "-y", "--agent", "pi"]);
  if (isGlobal) args.push("-g");

  try {
    const { stdout, stderr } = await runNpx(args, {
      timeout: 180_000,
      cwd: !isGlobal && params.cwd ? params.cwd : undefined,
      env: { FORCE_COLOR: "0" },
    });
    const output = (stdout + stderr).replace(ANSI_RE, "");
    const success = /Installation complete|Installed \d+ skill/.test(output);
    if (!success) throw new Error(output.slice(-300) || "Install failed");
    return { ok: true as const, output };
  } catch (e: unknown) {
    if (e instanceof ToolchainError) throw e;
    const err = e as { stdout?: string; stderr?: string; message?: string };
    const output = ((err.stdout ?? "") + (err.stderr ?? "")).replace(ANSI_RE, "");
    throw new Error(output || err.message || String(e));
  }
}
