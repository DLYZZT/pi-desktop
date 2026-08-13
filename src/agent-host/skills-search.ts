import type { SkillSearchResult } from "../shared/api-types.ts";

const ANSI_RE = /\x1B\[[0-9;]*m/g;

function parseInstallCount(installs: string): number {
  const match = installs.match(/^([\d.,]+)([KMB])?\s+installs?$/);
  if (!match) return 0;
  const value = Number(match[1].replaceAll(",", ""));
  if (!Number.isFinite(value)) return 0;
  const multiplier = match[2] === "B" ? 1_000_000_000 : match[2] === "M" ? 1_000_000 : match[2] === "K" ? 1_000 : 1;
  return value * multiplier;
}

export function parseSkillsSearchOutput(raw: string): SkillSearchResult[] {
  const clean = raw.replace(ANSI_RE, "");
  const results: SkillSearchResult[] = [];
  const lines = clean.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    const packageMatch = line.match(/^([\w.\-]+\/[\w.\-@:]+)\s+([\d.,]+[KMB]?\s+installs)$/);
    if (!packageMatch) continue;
    const urlLine = lines[i + 1]?.trim().replace(/^└\s*/, "");
    results.push({
      package: packageMatch[1],
      installs: parseInstallCount(packageMatch[2]),
      url: urlLine?.startsWith("https://") ? urlLine : "",
    });
  }
  return results;
}

export function normalizeSkillsApiResults(
  skills: Array<{ id?: string; name?: string; source?: string; installs?: number }>,
  searchApiBase: string,
): SkillSearchResult[] {
  return skills
    .map((skill) => {
      const name = skill.name?.trim();
      const source = skill.source?.trim();
      const slug = skill.id?.trim();
      if (!name || (!source && !slug)) return null;
      return {
        package: `${source || slug}@${name}`,
        installs: Number.isFinite(skill.installs) && (skill.installs ?? 0) > 0 ? (skill.installs ?? 0) : 0,
        url: slug ? `${searchApiBase}/${slug}` : "",
      };
    })
    .filter((result): result is SkillSearchResult => result !== null)
    .sort((a, b) => b.installs - a.installs);
}
