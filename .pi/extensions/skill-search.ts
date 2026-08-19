/**
 * Slim skill catalog + on-demand search.
 *
 * Pi injects every visible skill name+description into the system prompt.
 * With 100+ skills that is thousands of tokens every turn.
 *
 * This extension:
 * 1. Strips the <available_skills> dump before the model sees it
 * 2. Exposes skill_search so the model can find a skill, then read SKILL.md
 *
 * /skill:name still works. Discovery still happens at session start (cheap);
 * only the prompt injection is deferred.
 */

import type { ExtensionAPI, Skill } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const SKILLS_BLOCK = /\n\nThe following skills provide specialized instructions[\s\S]*?<\/available_skills>/;

const SEARCH_HINT = `

Skills are not preloaded in this prompt. Use skill_search when a task may match a specialized workflow, then read the returned location file. Users can still invoke /skill:name.
`;

const DEFAULT_LIMIT = 8;
const MAX_LIMIT = 20;

let catalog: Skill[] = [];

function tokens(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9\u4e00-\u9fff]+/)
    .filter((part) => part.length > 1);
}

function scoreSkill(skill: Skill, query: string): number {
  const q = query.trim().toLowerCase();
  if (!q) return 0;
  const name = skill.name.toLowerCase();
  const desc = skill.description.toLowerCase();
  if (name === q) return 1000;
  if (name.includes(q)) return 400;
  if (desc.includes(q)) return 120;

  const queryTokens = tokens(q);
  if (queryTokens.length === 0) return 0;
  const hay = `${name} ${desc}`;
  let hits = 0;
  for (const token of queryTokens) {
    if (name.includes(token)) hits += 3;
    else if (hay.includes(token)) hits += 1;
  }
  return hits === 0 ? 0 : hits;
}

function formatHits(hits: Array<{ skill: Skill; score: number }>): string {
  if (hits.length === 0) {
    return "No matching skills. Try fewer or different keywords. /skill:name still works if you know the name.";
  }
  const lines = hits.map(({ skill, score }) => {
    const hidden = skill.disableModelInvocation ? " hidden-from-default-catalog" : "";
    return `- ${skill.name} (${score})${hidden}\n  ${skill.description}\n  location: ${skill.filePath}`;
  });
  return `Found ${hits.length} skill(s). Read the location file to load instructions.\n\n${lines.join("\n\n")}`;
}

export default function skillSearchExtension(pi: ExtensionAPI) {
  pi.registerTool({
    name: "skill_search",
    label: "Skill Search",
    description:
      "Search installed skills by task or keywords. Returns name, description, and SKILL.md path. Then use read on that path. Use when a specialized workflow may exist.",
    parameters: Type.Object({
      query: Type.String({ description: "Task or keywords, e.g. debug, figma, commit" }),
      limit: Type.Optional(Type.Number({ description: "Max results, default 8" })),
    }),
    async execute(_toolCallId, params) {
      const limit = Math.min(Math.max(1, Math.floor(params.limit ?? DEFAULT_LIMIT)), MAX_LIMIT);
      const ranked = catalog
        .map((skill) => ({ skill, score: scoreSkill(skill, params.query) }))
        .filter((row) => row.score > 0)
        .sort((a, b) => b.score - a.score || a.skill.name.localeCompare(b.skill.name))
        .slice(0, limit);

      return {
        content: [{ type: "text", text: formatHits(ranked) }],
        details: {
          query: params.query,
          total: catalog.length,
          matches: ranked.map((row) => row.skill.name),
        },
      };
    },
  });

  pi.on("before_agent_start", async (event) => {
    const skills = event.systemPromptOptions.skills;
    if (skills && skills.length > 0) catalog = skills;

    const stripped = event.systemPrompt.replace(SKILLS_BLOCK, "");
    if (stripped === event.systemPrompt) return;

    return { systemPrompt: `${stripped}${SEARCH_HINT}` };
  });
}
