import assert from "node:assert/strict";
import test from "node:test";

import { canResumeSensitiveAgentControl } from "./browser-sensitive-control.ts";

test("sensitive approval resumes only the unchanged waiting control generation", () => {
  assert.equal(canResumeSensitiveAgentControl(7, 7, "waiting-for-approval"), true);
  assert.equal(canResumeSensitiveAgentControl(7, 8, "waiting-for-approval"), false);
  assert.equal(canResumeSensitiveAgentControl(7, 7, "user"), false);
  assert.equal(canResumeSensitiveAgentControl(7, 7, "agent"), false);
});
