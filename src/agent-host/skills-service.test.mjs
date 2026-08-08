import assert from "node:assert/strict";
import test from "node:test";
import { buildSkillsCliArgs } from "./skills-cli.ts";

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
