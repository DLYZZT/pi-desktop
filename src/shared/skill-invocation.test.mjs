import assert from "node:assert/strict";
import test from "node:test";

import { parseSkillInvocation, skillInvocationCommandText } from "./skill-invocation.ts";

const expanded = `<skill name="review" location="/home/test/.pi/skills/review/SKILL.md">
References are relative to /home/test/.pi/skills/review.

# Review

Private implementation instructions.
</skill>

Check the current change`;

test("parses Pi's persisted skill invocation shape", () => {
  assert.deepEqual(parseSkillInvocation(expanded), {
    name: "review",
    location: "/home/test/.pi/skills/review/SKILL.md",
    content:
      "References are relative to /home/test/.pi/skills/review.\n\n# Review\n\nPrivate implementation instructions.",
    userMessage: "Check the current change",
  });
});

test("restores a user-facing slash command without exposing the skill body", () => {
  assert.equal(skillInvocationCommandText(expanded), "/skill:review Check the current change");
  assert.equal(
    skillInvocationCommandText(`<skill name="review" location="C:\\skills\\review\\SKILL.md">\nInstructions\n</skill>`),
    "/skill:review",
  );
});

test("leaves ordinary and malformed messages unchanged", () => {
  assert.equal(skillInvocationCommandText("ordinary message"), "ordinary message");
  assert.equal(
    skillInvocationCommandText('<skill name="review">broken</skill>'),
    '<skill name="review">broken</skill>',
  );
});
