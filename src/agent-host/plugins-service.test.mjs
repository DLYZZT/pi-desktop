import assert from "node:assert/strict";
import test from "node:test";

import { classifyPluginSource, getConfiguredPluginVersion, getPluginResourceName } from "./plugins-policy.ts";

test("plugin sources select only their required managed toolchains", () => {
  assert.deepEqual(classifyPluginSource("npm:@scope/plugin@1.2.3"), { needsNpm: true, needsGit: false });
  for (const source of ["git:https://example.test/repo.git", "https://example.test/repo.git", "git@example:repo.git"]) {
    assert.deepEqual(classifyPluginSource(source), { needsNpm: false, needsGit: true });
  }
  assert.deepEqual(classifyPluginSource("./local-plugin"), { needsNpm: false, needsGit: false });
});

test("configured versions and resource names are derived without executing packages", () => {
  assert.equal(getConfiguredPluginVersion("npm:@scope/plugin@1.2.3"), "1.2.3");
  assert.equal(getConfiguredPluginVersion("npm:plugin"), undefined);
  assert.equal(getConfiguredPluginVersion("https://example.test/repo.git@v2"), "v2");
  assert.equal(getPluginResourceName("/pkg/extensions/index.ts", "extension"), "extensions");
  assert.equal(getPluginResourceName("/pkg/skills/review/SKILL.md", "skill"), "review");
  assert.equal(getPluginResourceName("/pkg/prompts/explain.md", "prompt"), "explain");
});
