import { importTestBundle } from "#test-bundle";
import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

const { updateSkillModelInvocation } = await importTestBundle("src/agent-host/skill-frontmatter", {
  packages: "external",
  absWorkingDir: path.resolve(import.meta.dirname, "../.."),
  entryPoints: ["src/agent-host/skill-frontmatter.ts"],
});

test("removes only the frontmatter invocation key and preserves the same line in the body", () => {
  const content = [
    "---",
    "name: sample",
    "description: Test skill",
    "disable-model-invocation: true",
    "---",
    "# Instructions",
    "disable-model-invocation: keep this body line",
    "",
  ].join("\n");

  const updated = updateSkillModelInvocation(content, false);
  assert.equal(updated.includes("description: Test skill"), true);
  assert.equal(updated.includes("disable-model-invocation: true"), false);
  assert.equal(updated.includes("disable-model-invocation: keep this body line"), true);
});

test("preserves multiline YAML and comments while setting the invocation key", () => {
  const content = [
    "---",
    "name: sample",
    "# Preserve this comment",
    "description: |",
    "  First line",
    "  Second line",
    "---",
    "Body with a later --- delimiter.",
    "---",
    "disable-model-invocation: body metadata",
  ].join("\n");

  const updated = updateSkillModelInvocation(content, true);
  assert.match(updated, /# Preserve this comment/);
  assert.match(updated, /description: \|\n {2}First line\n {2}Second line/);
  assert.match(updated, /disable-model-invocation: true\n---\nBody/);
  assert.match(updated, /disable-model-invocation: body metadata$/);
});

test("creates frontmatter without changing CRLF body bytes", () => {
  const body = "# Instructions\r\ndisable-model-invocation: body text\r\n";
  const updated = updateSkillModelInvocation(body, true);

  assert.equal(updated, `---\r\ndisable-model-invocation: true\r\n---\r\n${body}`);
});
