import { importTestBundle } from "#test-bundle";
import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

const { subscribeActiveSessionLiveSync } = await importTestBundle("src/renderer/hooks/active-session-live-sync", {
  entryPoints: [path.join(import.meta.dirname, "active-session-live-sync.ts")],
});

test("an idle active session subscribes before local prompts and refreshes only for its external changes", async () => {
  const calls = [];
  let onSessionChange;
  let agentClosed = 0;
  let changesClosed = 0;
  let refreshes = 0;

  const unsubscribe = await subscribeActiveSessionLiveSync({
    sessionId: "session-one",
    async connectAgentEvents(sessionId) {
      calls.push(["agent", sessionId]);
      return () => {
        agentClosed += 1;
      };
    },
    async subscribeSessionChanges(onChange) {
      calls.push(["sessions"]);
      onSessionChange = onChange;
      return () => {
        changesClosed += 1;
      };
    },
    onSessionChanged() {
      refreshes += 1;
    },
  });

  assert.deepEqual(calls, [["agent", "session-one"], ["sessions"]]);
  onSessionChange({ cwd: "/tmp/two", sessionId: "session-two" });
  assert.equal(refreshes, 0);
  onSessionChange({ cwd: "/tmp/one", sessionId: "session-one" });
  assert.equal(refreshes, 1);

  unsubscribe();
  unsubscribe();
  assert.equal(agentClosed, 1);
  assert.equal(changesClosed, 1);
});
