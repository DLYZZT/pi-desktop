import assert from "node:assert/strict";
import test from "node:test";

import { bundledPiCliPath } from "./session-tui-spawn.ts";
import { applySessionTuiSelect } from "./session-tui.ts";

test("selecting a session with no live process spawns bundled pi --session in that cwd", () => {
  const spawned = [];
  const result = applySessionTuiSelect(
    { sessionId: "sess-1", cwd: "F:/Project/claude/skills" },
    { bundledPi: "F:/bundled/pi-cli.js" },
    {
      spawn(request) {
        spawned.push(request);
      },
    },
  );

  assert.deepEqual(result, {
    action: "spawn",
    sessionId: "sess-1",
    cwd: "F:/Project/claude/skills",
    program: "F:/bundled/pi-cli.js",
    args: ["--session", "sess-1"],
  });
  assert.deepEqual(spawned, [result]);
  assert.notEqual(result.program, "pi");
  assert.equal(spawned.length, 1);
});

test("bundled pi is the packaged cli, not PATH pi", () => {
  assert.match(bundledPiCliPath().replaceAll("\\", "/"), /@earendil-works\/pi-coding-agent\/dist\/cli\.js$/);
});
