import assert from "node:assert/strict";
import path from "node:path";
import test, { after } from "node:test";
import { createElement, StrictMode } from "react";
import { act, create } from "react-test-renderer";
import { importTestBundle } from "#test-bundle";
import { createDeferred } from "#test-timing";

const previousAct = globalThis.IS_REACT_ACT_ENVIRONMENT;
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
after(() => {
  if (previousAct === undefined) delete globalThis.IS_REACT_ACT_ENVIRONMENT;
  else globalThis.IS_REACT_ACT_ENVIRONMENT = previousAct;
});

const { useSessionEvents, api } = await importTestBundle("session-events-hook", {
  stdin: {
    contents: 'export { useSessionEvents } from "./useSessionEvents.ts"; export * as api from "@/lib/api-client";',
    resolveDir: import.meta.dirname,
    loader: "ts",
  },
  tsconfig: path.join(import.meta.dirname, "../../../tsconfig.renderer.json"),
  external: ["react", "react-dom", "react-dom/*"],
  plugins: [
    {
      name: "session-streams",
      setup(build) {
        build.onResolve({ filter: /^@\/lib\/api-client$/ }, ({ path }) => ({ path, namespace: "streams-test" }));
        build.onLoad({ filter: /.*/, namespace: "streams-test" }, () => ({
          loader: "js",
          contents: `
          export const subscriptions = [];
          const pending = {agent: [], changes: []};
          export function enqueue(kind, result) { pending[kind].push(result); }
          export function reset() { subscriptions.length = pending.agent.length = pending.changes.length = 0; }
          async function subscribe(kind, sid, onEvent) {
            const subscription = {kind, sid, onEvent, closed: 0};
            subscriptions.push(subscription);
            await pending[kind].shift();
            return () => subscription.closed++;
          }
          export const subscribeAgentEvents = (sid, onEvent) => subscribe('agent', sid, onEvent);
          export const subscribeSessionsChanged = (onEvent) => subscribe('changes', '*', onEvent);
        `,
        }));
      },
    },
  ],
});

async function mount(t, { id = "a", strict = false, retryWait } = {}) {
  const sessionIdRef = { current: id };
  const events = [],
    refreshes = [],
    streamErrors = [];
  let current, renderer;
  function Probe() {
    current = useSessionEvents({
      sessionIdRef,
      onSessionChanged: (sid) => refreshes.push(sid),
      onAgentEventsError: (message) => streamErrors.push(message),
      ...(retryWait ? { retryWait } : {}),
    });
    current.handleAgentEventRef.current = (event) => events.push(event);
    return null;
  }
  await act(async () => {
    renderer = create(strict ? createElement(StrictMode, null, createElement(Probe)) : createElement(Probe));
  });
  const unmount = async () => {
    if (renderer) await act(async () => renderer.unmount());
    renderer = null;
  };
  t.after(unmount);
  return {
    get current() {
      return current;
    },
    sessionIdRef,
    events,
    refreshes,
    streamErrors,
    unmount,
  };
}

function silenceConsoleError(t) {
  const original = console.error,
    errors = [];
  console.error = (...args) => errors.push(args);
  t.after(() => {
    console.error = original;
  });
  return errors;
}

test("idle views receive live events and only their persisted changes, using the latest callback", async (t) => {
  api.reset();
  const fixture = await mount(t);
  const [agent, changes] = api.subscriptions;
  assert.deepEqual(
    api.subscriptions.map((s) => [s.kind, s.sid]),
    [
      ["agent", "a"],
      ["changes", "*"],
    ],
  );
  agent.onEvent({ type: "agent_start" });
  changes.onEvent({ sessionId: "b" });
  changes.onEvent({ cwd: null, projectInfoChanged: true });
  changes.onEvent({ sessionId: "a" });
  changes.onEvent({ fullRefresh: true });
  assert.deepEqual(fixture.events, [{ type: "agent_start" }]);
  assert.deepEqual(fixture.refreshes, ["a", "a"]);
  fixture.current.handleAgentEventRef.current = (event) => fixture.events.push({ ...event, updated: true });
  agent.onEvent({ type: "prompt_done" });
  assert.equal(fixture.events[1].updated, true);
  await fixture.unmount();
  agent.onEvent({ type: "ghost" });
  changes.onEvent({ fullRefresh: true });
  assert.equal(fixture.events.length, 2);
  assert.equal(fixture.refreshes.length, 2);
  assert.deepEqual(
    api.subscriptions.map((s) => s.closed),
    [1, 1],
  );
});

for (const kind of ["agent", "changes"]) {
  test(`unmount closes installed subscriptions without waiting for the late ${kind} stream`, async (t) => {
    api.reset();
    const pending = createDeferred();
    api.enqueue(kind, pending.promise);
    const fixture = await mount(t);
    await fixture.unmount();
    assert.equal(api.subscriptions.find((s) => s.kind !== kind).closed, 1);
    await act(async () => {
      pending.resolve();
      await pending.promise;
    });
    assert.deepEqual(
      api.subscriptions.map((s) => s.closed),
      [1, 1],
    );
    for (const subscription of api.subscriptions) subscription.onEvent({ sessionId: "a", type: "ghost" });
    assert.deepEqual(fixture.events, []);
    assert.deepEqual(fixture.refreshes, []);
    await fixture.current.ensureEventsConnected("a");
    assert.equal(api.subscriptions.length, 2, "background commands must not revive an unmounted view's subscriptions");
  });
}

test("new-session promotion retains the changes stream and starts observing the assigned ID", async (t) => {
  api.reset();
  const fixture = await mount(t, { id: null });
  assert.equal(api.subscriptions.length, 1);
  const changes = api.subscriptions[0];
  changes.onEvent({ fullRefresh: true });
  assert.deepEqual(fixture.refreshes, []);
  fixture.sessionIdRef.current = "new";
  await act(async () => fixture.current.ensureEventsConnected("new"));
  changes.onEvent({ sessionId: "new" });
  assert.deepEqual(fixture.refreshes, ["new"]);
  assert.equal(api.subscriptions.filter((s) => s.kind === "changes").length, 1);
  assert.equal(changes.closed, 0);
});

test("reconnecting retires the old stream and ignores a late old installation", async (t) => {
  api.reset();
  const fixture = await mount(t);
  const pending = createDeferred();
  api.enqueue("agent", pending.promise);
  let oldConnection;
  await act(async () => {
    oldConnection = fixture.current.connectEvents("a");
  });
  const old = api.subscriptions.at(-1);
  await act(async () => fixture.current.ensureEventsConnected("a"));
  const latest = api.subscriptions.at(-1);
  await act(async () => {
    pending.resolve();
    assert.equal((await oldConnection).status, "closed");
  });
  old.onEvent({ type: "ghost" });
  latest.onEvent({ type: "agent_start" });
  assert.equal(old.closed, 1);
  assert.equal(latest.closed, 0);
  assert.deepEqual(fixture.events, [{ type: "agent_start" }]);
  assert.equal(api.subscriptions.find((s) => s.kind === "changes").closed, 0);
});

test("a failed agent connection leaves the persisted-change fallback subscribed", async (t) => {
  api.reset();
  const failure = createDeferred();
  api.enqueue("agent", failure.promise);
  const errors = silenceConsoleError(t);
  const fixture = await mount(t);
  await act(async () => {
    failure.reject(new Error("offline"));
  });
  api.subscriptions.find((s) => s.kind === "changes").onEvent({ sessionId: "a" });
  assert.deepEqual(fixture.refreshes, ["a"]);
  assert.equal(errors.filter(([message]) => message.startsWith("Failed to subscribe")).length, 1);
  assert.equal(fixture.streamErrors.length, 1);
  assert.match(fixture.streamErrors[0], /EVENT_STREAM_CLOSED/);
});

test("StrictMode setup cleanup retains only one active stream of each kind", async (t) => {
  api.reset();
  const fixture = await mount(t, { strict: true });
  assert.deepEqual(
    api.subscriptions
      .filter((s) => !s.closed)
      .map((s) => s.kind)
      .sort(),
    ["agent", "changes"],
  );
  await fixture.unmount();
  assert.ok(api.subscriptions.every((s) => s.closed === 1));
});

test("a failed mount subscription retries with backoff and recovers live events", async (t) => {
  api.reset();
  silenceConsoleError(t);
  const waits = [];
  const failure = createDeferred();
  api.enqueue("agent", failure.promise);
  api.enqueue("agent", Promise.resolve());
  const fixture = await mount(t, {
    retryWait: async (ms) => {
      waits.push(ms);
    },
  });
  await act(async () => {
    failure.reject(new Error("offline"));
  });
  assert.deepEqual(waits, [1000]);
  assert.equal(fixture.streamErrors.length, 1, "the episode is reported once, not per retry");
  const agentSubs = api.subscriptions.filter((s) => s.kind === "agent");
  assert.equal(agentSubs.length, 2);
  assert.equal(agentSubs[1].closed, 0);
  agentSubs[0].onEvent({ type: "ghost" });
  assert.deepEqual(fixture.events, [], "the retired attempt must not deliver events");
  agentSubs[1].onEvent({ type: "agent_start" });
  assert.deepEqual(fixture.events, [{ type: "agent_start" }]);
});

test("retry backoff grows to the cap and stops once connected", async (t) => {
  api.reset();
  silenceConsoleError(t);
  const waits = [];
  for (let i = 0; i < 5; i++) api.enqueue("agent", Promise.reject(new Error("offline")));
  api.enqueue("agent", Promise.resolve());
  const fixture = await mount(t, {
    retryWait: async (ms) => {
      waits.push(ms);
    },
  });
  assert.deepEqual(waits, [1000, 2000, 4000, 8000, 8000]);
  assert.equal(fixture.streamErrors.length, 1);
  const agentSubs = api.subscriptions.filter((s) => s.kind === "agent");
  assert.equal(agentSubs.length, 6);
  assert.equal(agentSubs.at(-1).closed, 0);
  for (const subscription of agentSubs.slice(0, -1)) subscription.onEvent({ type: "ghost" });
  assert.deepEqual(fixture.events, [], "only the newest attempt may deliver events");
  agentSubs.at(-1).onEvent({ type: "agent_start" });
  assert.deepEqual(fixture.events, [{ type: "agent_start" }]);
});

test("unmount during backoff stops the retry loop", async (t) => {
  api.reset();
  silenceConsoleError(t);
  const waitGate = createDeferred();
  api.enqueue("agent", Promise.reject(new Error("offline")));
  const fixture = await mount(t, { retryWait: () => waitGate.promise });
  assert.equal(fixture.streamErrors.length, 1);
  await fixture.unmount();
  await act(async () => {
    waitGate.resolve();
  });
  assert.equal(api.subscriptions.filter((s) => s.kind === "agent").length, 1);
});

test("a send-path reconnect stands down the pending retry", async (t) => {
  api.reset();
  silenceConsoleError(t);
  const waitGate = createDeferred();
  api.enqueue("agent", Promise.reject(new Error("offline")));
  const fixture = await mount(t, { retryWait: () => waitGate.promise });
  api.enqueue("agent", Promise.resolve());
  await act(async () => fixture.current.ensureEventsConnected("a"));
  await act(async () => {
    waitGate.resolve();
  });
  const agentSubs = api.subscriptions.filter((s) => s.kind === "agent");
  assert.equal(agentSubs.length, 2, "the retry must not clobber the healthy send-path stream");
  assert.equal(agentSubs.at(-1).closed, 0);
  agentSubs.at(-1).onEvent({ type: "agent_start" });
  assert.deepEqual(fixture.events, [{ type: "agent_start" }]);
});

test("switching session during backoff stops the retry for the old ID", async (t) => {
  api.reset();
  silenceConsoleError(t);
  const waitGate = createDeferred();
  api.enqueue("agent", Promise.reject(new Error("offline")));
  const fixture = await mount(t, { retryWait: () => waitGate.promise });
  fixture.sessionIdRef.current = "b";
  await act(async () => {
    waitGate.resolve();
  });
  assert.deepEqual(
    api.subscriptions.filter((s) => s.kind === "agent").map((s) => s.sid),
    ["a"],
  );
});

test("a superseded mount attempt is aborted silently, not reported as a failure", async (t) => {
  api.reset();
  const errors = silenceConsoleError(t);
  const first = createDeferred();
  api.enqueue("agent", first.promise);
  api.enqueue("agent", Promise.resolve());
  // StrictMode's setup → cleanup → setup aborts the first attempt while its
  // subscribe is still in flight; the remount owns a fresh lifetime.
  const fixture = await mount(t, { strict: true });
  await act(async () => {
    first.resolve();
    await first.promise;
  });
  assert.deepEqual(fixture.streamErrors, [], "the superseded attempt must not surface a connection notice");
  assert.equal(errors.filter(([message]) => message.startsWith("Failed to subscribe")).length, 0);
  // The remount's stream is the live one.
  const live = api.subscriptions.filter((s) => !s.closed && s.kind === "agent");
  assert.equal(live.length, 1);
  live[0].onEvent({ type: "agent_start" });
  assert.deepEqual(fixture.events, [{ type: "agent_start" }]);
});
