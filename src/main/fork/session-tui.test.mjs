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

test("selecting a live session focuses its terminal and does not spawn again", () => {
  const spawned = [];
  const focused = [];
  const live = new Set();
  const port = {
    spawn(request) {
      spawned.push(request);
    },
    focus(request) {
      focused.push(request);
    },
  };
  const bundled = { bundledPi: "F:/bundled/pi-cli.js" };
  const session = { sessionId: "sess-1", cwd: "F:/Project/claude/skills" };

  applySessionTuiSelect(session, bundled, port, live);
  const second = applySessionTuiSelect(session, bundled, port, live);

  assert.deepEqual(second, { action: "focus", sessionId: "sess-1" });
  assert.equal(spawned.length, 1);
  assert.deepEqual(focused, [second]);
  assert.equal(live.has("sess-1"), true);
});

test("switching sessions keeps the previous pi live and only spawns the new one", () => {
  const spawned = [];
  const focused = [];
  const live = new Set();
  const port = {
    spawn(request) {
      spawned.push(request.sessionId);
    },
    focus(request) {
      focused.push(request.sessionId);
    },
  };
  const bundled = { bundledPi: "F:/bundled/pi-cli.js" };

  applySessionTuiSelect({ sessionId: "sess-1", cwd: "F:/a" }, bundled, port, live);
  applySessionTuiSelect({ sessionId: "sess-2", cwd: "F:/b" }, bundled, port, live);
  const back = applySessionTuiSelect({ sessionId: "sess-1", cwd: "F:/a" }, bundled, port, live);

  assert.deepEqual(spawned, ["sess-1", "sess-2"]);
  assert.deepEqual(back, { action: "focus", sessionId: "sess-1" });
  assert.deepEqual(focused, ["sess-1"]);
  assert.equal(live.has("sess-1"), true);
  assert.equal(live.has("sess-2"), true);
});
