import assert from "node:assert/strict";
import test from "node:test";

import { bundledPiCliPath, parseAliveSessionIds } from "./session-tui-spawn.ts";
import {
  applySessionTuiExited,
  applySessionTuiKill,
  applySessionTuiQuit,
  applySessionTuiSelect,
  reconcileSessionTuiMarks,
  sessionTuiMarkOf,
} from "./session-tui.ts";

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
  const marks = new Map();
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

  applySessionTuiSelect(session, bundled, port, marks);
  const second = applySessionTuiSelect(session, bundled, port, marks);

  assert.deepEqual(second, { action: "focus", sessionId: "sess-1" });
  assert.equal(spawned.length, 1);
  assert.deepEqual(focused, [second]);
  assert.equal(sessionTuiMarkOf(marks, "sess-1"), "running");
});

test("switching sessions keeps the previous pi live and only spawns the new one", () => {
  const spawned = [];
  const focused = [];
  const marks = new Map();
  const port = {
    spawn(request) {
      spawned.push(request.sessionId);
    },
    focus(request) {
      focused.push(request.sessionId);
    },
  };
  const bundled = { bundledPi: "F:/bundled/pi-cli.js" };

  applySessionTuiSelect({ sessionId: "sess-1", cwd: "F:/a" }, bundled, port, marks);
  applySessionTuiSelect({ sessionId: "sess-2", cwd: "F:/b" }, bundled, port, marks);
  const back = applySessionTuiSelect({ sessionId: "sess-1", cwd: "F:/a" }, bundled, port, marks);

  assert.deepEqual(spawned, ["sess-1", "sess-2"]);
  assert.deepEqual(back, { action: "focus", sessionId: "sess-1" });
  assert.deepEqual(focused, ["sess-1"]);
  assert.equal(sessionTuiMarkOf(marks, "sess-1"), "running");
  assert.equal(sessionTuiMarkOf(marks, "sess-2"), "running");
});

test("quit kills every live session and leaves an empty process map", () => {
  const killed = [];
  const marks = new Map([
    ["sess-1", "running"],
    ["sess-2", "running"],
  ]);
  applySessionTuiQuit(marks, {
    killAll(sessionIds) {
      killed.push(...sessionIds);
    },
  });
  assert.deepEqual(killed.sort(), ["sess-1", "sess-2"]);
  assert.equal(marks.size, 0);
});

test("kill marks the session dead without spawning and a later select respawns", () => {
  const spawned = [];
  const killed = [];
  const marks = new Map();
  const port = {
    spawn(request) {
      spawned.push(request.sessionId);
    },
    focus() {},
    kill(sessionIds) {
      killed.push(...sessionIds);
    },
  };
  const bundled = { bundledPi: "F:/bundled/pi-cli.js" };
  const session = { sessionId: "sess-1", cwd: "F:/a" };

  applySessionTuiSelect(session, bundled, port, marks);
  applySessionTuiKill("sess-1", marks, port);

  assert.deepEqual(killed, ["sess-1"]);
  assert.equal(sessionTuiMarkOf(marks, "sess-1"), "dead");
  assert.equal(spawned.length, 1);

  const again = applySessionTuiSelect(session, bundled, port, marks);
  assert.equal(again.action, "spawn");
  assert.equal(sessionTuiMarkOf(marks, "sess-1"), "running");
  assert.deepEqual(spawned, ["sess-1", "sess-1"]);
});

test("child exit marks running dead without spawning", () => {
  const marks = new Map([["sess-1", "running"]]);
  applySessionTuiExited("sess-1", marks);
  assert.equal(sessionTuiMarkOf(marks, "sess-1"), "dead");
});

test("reconcile marks missing processes dead and leaves unknown sessions unmarked", () => {
  const marks = new Map([
    ["alive", "running"],
    ["gone", "running"],
  ]);
  reconcileSessionTuiMarks(marks, ["alive"]);
  assert.equal(sessionTuiMarkOf(marks, "alive"), "running");
  assert.equal(sessionTuiMarkOf(marks, "gone"), "dead");
  assert.equal(sessionTuiMarkOf(marks, "never"), null);
});

test("parseAliveSessionIds reads --session ids from process listings", () => {
  assert.deepEqual(
    parseAliveSessionIds(
      'electron.exe --session abc\r\nwt.exe\r\n"F:\\bundled\\pi-cli.js" --session abc --session def',
    ).sort(),
    ["abc", "def"],
  );
});

test("selecting an archived session still spawn or focus; archive itself is not a process action", () => {
  const spawned = [];
  const killed = [];
  const marks = new Map();
  const port = {
    spawn(request) {
      spawned.push(request.sessionId);
    },
    focus() {},
    kill(sessionIds) {
      killed.push(...sessionIds);
    },
  };
  assert.equal(marks.size, 0);
  assert.deepEqual(killed, []);
  const first = applySessionTuiSelect(
    { sessionId: "archived-1", cwd: "F:/old" },
    { bundledPi: "F:/bundled/pi-cli.js" },
    port,
    marks,
  );
  const second = applySessionTuiSelect(
    { sessionId: "archived-1", cwd: "F:/old" },
    { bundledPi: "F:/bundled/pi-cli.js" },
    port,
    marks,
  );
  assert.equal(first.action, "spawn");
  assert.equal(second.action, "focus");
  assert.deepEqual(killed, []);
});
