import assert from "node:assert/strict";
import test from "node:test";
import { buildSkillsCliArgs } from "./skills-cli.ts";
import { normalizeSkillsApiResults, parseSkillsSearchOutput } from "./skills-search.ts";

test("pins the skills CLI and keeps npx flags before the executable", () => {
  assert.deepEqual(buildSkillsCliArgs(["add", "mattpocock/skills@grill-me", "-y", "--agent", "pi", "-g"]), [
    "--yes",
    "--package",
    "skills@1.5.22",
    "--",
    "skills",
    "add",
    "mattpocock/skills@grill-me",
    "-y",
    "--agent",
    "pi",
    "-g",
  ]);
});

test("normalizes CLI install counts to numbers for locale-aware rendering", () => {
  const results = parseSkillsSearchOutput(`
owner/repo@popular 1.2M installs
└ https://skills.sh/owner/repo/popular
owner/repo@small 1,234 installs
└ https://skills.sh/owner/repo/small
`);
  assert.deepEqual(results, [
    { package: "owner/repo@popular", installs: 1_200_000, url: "https://skills.sh/owner/repo/popular" },
    { package: "owner/repo@small", installs: 1_234, url: "https://skills.sh/owner/repo/small" },
  ]);
});

test("normalizes and sorts API install counts without English suffixes", () => {
  const results = normalizeSkillsApiResults(
    [
      { id: "owner/repo/small", name: "small", source: "owner/repo", installs: 42 },
      { id: "owner/repo/popular", name: "popular", source: "owner/repo", installs: 1_200_000 },
    ],
    "https://skills.sh",
  );
  assert.deepEqual(
    results.map(({ package: packageName, installs }) => ({ package: packageName, installs })),
    [
      { package: "owner/repo@popular", installs: 1_200_000 },
      { package: "owner/repo@small", installs: 42 },
    ],
  );
});
