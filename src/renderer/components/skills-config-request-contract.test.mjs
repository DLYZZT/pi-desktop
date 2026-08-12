import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("./SkillsConfig.tsx", import.meta.url), "utf8");

test("SkillsConfig aborts superseded list requests and gates every settlement", () => {
  assert.match(source, /const skillsRequestRef = useRef\(new LatestAbortableRequest\(\)\)/);
  assert.match(source, /fetch\(`\/api\/skills\?cwd=.*?`, \{ signal: request\.signal \}\)/s);
  assert.match(source, /if \(!skillsRequestRef\.current\.isCurrent\(request\.generation\)\) return/);
  assert.match(source, /request\.signal\.aborted \|\| !skillsRequestRef\.current\.isCurrent\(request\.generation\)/);
  assert.match(source, /if \(skillsRequestRef\.current\.finish\(request\.generation\)\) setLoading\(false\)/);
  assert.match(source, /const requests = skillsRequestRef\.current/);
  assert.match(source, /return \(\) => \{\s*requests\.cancel\(\)/);
});

test("project changes clear the prior list and select only from the current response", () => {
  assert.match(source, /setSkills\(\[\]\);\s*setSelected\(null\);\s*void loadSkills\(\)/);
  assert.match(source, /list\.some\(\(skill\) => skill\.filePath === current\)/);
});
