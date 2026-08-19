import assert from "node:assert/strict";
import test from "node:test";

import { forkOnNewSession, forkOnSelectSession } from "./session-tui-select.ts";

test("folder + new session starts pi --session in that cwd", () => {
  const calls = [];
  globalThis.window = {
    piBridge: {
      startSessionTui(session) {
        calls.push(session);
      },
    },
  };
  forkOnNewSession("new-1", "F:/Project/claude/skills");
  assert.deepEqual(calls, [{ sessionId: "new-1", cwd: "F:/Project/claude/skills" }]);
});

test("selecting another session publishes the same start/focus path so the right pane can follow cwd", () => {
  const calls = [];
  globalThis.window = {
    piBridge: {
      startSessionTui(session) {
        calls.push(session);
      },
    },
  };
  forkOnSelectSession({
    id: "sess-2",
    path: "F:/PiData/agent/sessions/project/session.jsonl",
    cwd: "F:/Project/dlyzzt-pi-desktop",
  });
  assert.deepEqual(calls, [
    {
      sessionId: "sess-2",
      sessionPath: "F:/PiData/agent/sessions/project/session.jsonl",
      cwd: "F:/Project/dlyzzt-pi-desktop",
    },
  ]);
});
