/**
 * Skills search / install via skills.sh API or ELECTRON_RUN_AS_NODE npx.
 */
import { runNpx } from "./npx";
import type { SkillSearchResult } from "../shared/api-types";

const ANSI_RE = /\x1B\[[0-9;]*m/g;
const SEARCH_API_BASE = process.env.SKILLS_API_URL || "https://skills.sh";

function formatInstalls(count?: number): string {
  if (!count || count <= 0) return "";
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1).replace(/\.0$/, "")}M installs`;
  if (count >= 1_000) return `${(count / 1_000).toFixed(1).replace(/\.0$/, "")}K installs`;
  return `${count} install${count === 1 ? "" : "s"}`;
}

function parseInstallCount(installs: string): number {
  const match = installs.match(/^([\d.]+)([KMB])?\s+installs?$/);
  if (!match) return 0;
  const value = Number(match[1]);
  if (!Number.isFinite(value)) return 0;
  const multiplier =
    match[2] === "B" ? 1_000_000_000 : match[2] === "M" ? 1_000_000 : match[2] === "K" ? 1_000 : 1;
  return value * multiplier;
}

function parseSearchOutput(raw: string): SkillSearchResult[] {
  const clean = raw.replace(ANSI_RE, "");
  const results: SkillSearchResult[] = [];
  const lines = clean.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    const pkgMatch = line.match(/^([\w.\-]+\/[\w.\-@:]+)\s+([\d.,]+[KMB]?\s+installs)$/);
    if (pkgMatch) {
      const urlLine = lines[i + 1]?.trim().replace(/^└\s*/, "");
      results.push({
        package: pkgMatch[1],
        installs: pkgMatch[2],
        url: urlLine?.startsWith("https://") ? urlLine : "",
      });
    }
  }
  return results;
}

async function searchSkillsApi(query: string, limit: number): Promise<SkillSearchResult[]> {
  const url = `${SEARCH_API_BASE}/api/search?q=${encodeURIComponent(query)}&limit=${limit}`;
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) throw new Error(`skills.sh search failed: HTTP ${res.status}`);
  const data = (await res.json()) as {
    skills?: Array<{ id?: string; name?: string; source?: string; installs?: number }>;
  };
  return (data.skills ?? [])
    .map((skill) => {
      const name = skill.name?.trim();
      const source = skill.source?.trim();
      const slug = skill.id?.trim();
      if (!name || (!source && !slug)) return null;
      return {
        package: `${source || slug}@${name}`,
        installs: formatInstalls(skill.installs),
        url: slug ? `${SEARCH_API_BASE}/${slug}` : "",
      };
    })
    .filter((s): s is SkillSearchResult => s !== null)
    .sort((a, b) => parseInstallCount(b.installs) - parseInstallCount(a.installs));
}

export async function searchSkills(
  query: string,
  limit = 50,
): Promise<{ results: SkillSearchResult[] }> {
  const q = query.trim();
  if (!q) return { results: [] };
  const capped = Math.min(50, Math.max(1, limit));

  try {
    const results = await searchSkillsApi(q, capped);
    return { results };
  } catch {
    const { stdout, stderr } = await runNpx(["skills", "find", q], {
      timeout: 20_000,
      env: { ...process.env, FORCE_COLOR: "0" },
    });
    return { results: parseSearchOutput(stdout + stderr).slice(0, capped) };
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
  const args = ["skills", "add", pkg, "-y", "--agent", "pi"];
  if (isGlobal) args.push("-g");

  try {
    const { stdout, stderr } = await runNpx(args, {
      timeout: 60_000,
      cwd: !isGlobal && params.cwd ? params.cwd : undefined,
      env: { ...process.env, FORCE_COLOR: "0" },
    });
    const output = (stdout + stderr).replace(ANSI_RE, "");
    const success = /Installation complete|Installed \d+ skill/.test(output);
    if (!success) throw new Error(output.slice(-300) || "Install failed");
    return { ok: true as const, output };
  } catch (e: unknown) {
    const err = e as { stdout?: string; stderr?: string; message?: string };
    const output = ((err.stdout ?? "") + (err.stderr ?? "")).replace(ANSI_RE, "");
    throw new Error(output || err.message || String(e));
  }
}
