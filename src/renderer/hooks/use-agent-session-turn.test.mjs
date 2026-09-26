import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { createElement } from "react";
import { act, create } from "react-test-renderer";
import { importTestBundle } from "#test-bundle";
import { createDeferred } from "#test-timing";

const { useAgentSession, testApi } = await importTestBundle("session-turn-hook", {
  stdin: {
    contents: 'export { useAgentSession } from "./useAgentSession.ts"; export * as testApi from "@/lib/api-client";',
    resolveDir: import.meta.dirname,
    loader: "ts",
  },
  tsconfig: path.join(import.meta.dirname, "../../../tsconfig.renderer.json"),
  external: ["react", "react-dom", "react-dom/*"],
  plugins: [
    {
      name: "offline-session-turn",
      setup(build) {
        build.onResolve({ filter: /^@\/(i18n|lib\/(api-client|agent-client))$/ }, ({ path }) => ({
          path,
          namespace: "session-turn-test",
        }));
        build.onLoad({ filter: /.*/, namespace: "session-turn-test" }, ({ path }) => ({
          loader: "js",
          contents:
            path === "@/i18n"
              ? `
          const t = (_key, fallback) => fallback;
          export function useI18n() { return { language: "en-US", t }; }
        `
              : path === "@/lib/agent-client"
                ? `
          export { sendAgentCommand } from "@/lib/api-client";
        `
                : `
          export async function listModels() { return { models: [], catalog: { source: "cache", refreshed: false, aborted: false, warnings: [] } }; }
          export async function agentState() { return { running: false }; }
          export const connections = [];
          export async function subscribeAgentEvents(sid) { connections.push(sid); return () => {}; }
          export async function subscribeSessionsChanged() { return () => {}; }
          const pendingCommands = new Map();
          export const commands = [];
          export function queueCommand(type, value) { pendingCommands.set(type, value); }
          export async function sendAgentCommand(sid, command) {
            commands.push({sid, command});
            if (!pendingCommands.has(command.type)) throw new Error("unexpected command " + command.type);
            const result = pendingCommands.get(command.type); pendingCommands.delete(command.type);
            return await result;
          }
          export const newAgent = (params) => sendAgentCommand(null, params);
          export function resetCommands() { pendingCommands.clear(); commands.length = connections.length = 0; }
          let detail, page;
          export function setHistory(nextDetail, nextPage) { detail = nextDetail; page = nextPage; }
          export async function getSession() { if (!detail) throw new Error("unexpected detail read"); return detail; }
          export async function getSessionContextPage() { if (!page) throw new Error("unexpected page read"); return page; }
          const unexpected = async () => { throw new Error("unexpected session IO"); };
          export { unexpected as getSessionContext,
            unexpected as getSessionEntryContent, unexpected as refreshModels,
            unexpected as cancelModelsRefresh };
        `,
        }));
      },
    },
  ],
});

test("the session hook renders turn events and settles a multi-run prompt exactly once", async (t) => {
  const originals = new Map();
  const install = (name, value) => {
    originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  };
  install("IS_REACT_ACT_ENVIRONMENT", true);
  install("window", { addEventListener() {}, removeEventListener() {} });
  install("document", { visibilityState: "visible", addEventListener() {}, removeEventListener() {} });
  install("requestAnimationFrame", (callback) => {
    callback();
    return 0;
  });
  install("cancelAnimationFrame", () => {});
  let renderer;
  t.after(async () => {
    if (renderer) await act(async () => renderer.unmount());
    for (const [name, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete globalThis[name];
    }
  });
  let current;
  let completions = 0;
  const options = { session: null, newSessionCwd: null, onAgentEnd: () => completions++ };
  function Probe() {
    current = useAgentSession(options);
    return createElement("output", null, current.agentRunning ? "running" : "idle");
  }
  await act(async () => {
    renderer = create(createElement(Probe));
  });
  const emit = async (event) => act(async () => current.handleAgentEventRef.current(event));
  const message = { role: "assistant", content: [{ type: "text", text: "streamed reply" }] };

  await emit({ type: "agent_start" });
  assert.deepEqual(renderer.toJSON().children, ["running"]);
  await emit({ type: "message_update", message });
  assert.deepEqual(current.streamState.streamingMessage, message);
  await emit({ type: "message_end", message });
  assert.equal(current.messages.length, 1);
  assert.equal(current.streamState.streamingMessage, null);
  await emit({ type: "agent_end" });
  assert.equal(current.agentRunning, true, "an SDK boundary is not Desktop prompt settlement");
  assert.equal(completions, 0);

  await emit({ type: "queue_update", steering: ["steer"], followUp: ["later"] });
  assert.deepEqual(current.queuedMessages, { steering: ["steer"], followUp: ["later"] });
  await emit({ type: "auto_retry_start", attempt: 1, maxAttempts: 3 });
  assert.equal(current.retryInfo.attempt, 1);
  await emit({ type: "compaction_start" });
  assert.equal(current.isCompacting, true);
  await emit({ type: "compaction_end", aborted: true });
  assert.equal(current.isCompacting, false);

  await emit({ type: "prompt_done" });
  await emit({ type: "prompt_done" });
  assert.deepEqual(renderer.toJSON().children, ["idle"]);
  assert.equal(current.retryInfo, null);
  assert.equal(completions, 1);
  await emit({ type: "message_update", message });
  await emit({ type: "message_end", message });
  assert.equal(current.streamState.streamingMessage, null);
  assert.equal(current.messages.length, 1, "late completion does not append the persisted message again");
});

test("prepending history preserves the viewport instead of activating completion auto-follow", async (t) => {
  const originals = new Map();
  const install = (name, value) => {
    originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  };
  const frames = new Map();
  let sequence = 0;
  install("IS_REACT_ACT_ENVIRONMENT", true);
  install("window", { addEventListener() {}, removeEventListener() {} });
  install("document", { visibilityState: "visible", addEventListener() {}, removeEventListener() {} });
  install("requestAnimationFrame", (callback) => {
    frames.set(++sequence, callback);
    return sequence;
  });
  install("cancelAnimationFrame", (id) => frames.delete(id));
  install(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  const context = {
    messages: [{ role: "user", content: "tail" }],
    entryIds: ["tail"],
    historyRevision: "r1",
    previousCursor: "cursor",
    loadedMessages: 1,
    totalMessages: 2,
    truncatedBefore: true,
    model: null,
    thinkingLevel: "off",
  };
  testApi.setHistory(
    {
      sessionId: "fixture",
      info: { id: "fixture", cwd: "/fixture" },
      leafId: "tail",
      tree: [],
      context,
      agentState: { running: false },
    },
    {
      context: {
        ...context,
        messages: [{ role: "user", content: "older" }],
        entryIds: ["older"],
        previousCursor: undefined,
      },
    },
  );
  let current, renderer;
  const scrolls = [];
  const container = {
    scrollTop: 0,
    clientHeight: 600,
    get scrollHeight() {
      return 600 + (current?.messages.length ?? 0) * 2000;
    },
    querySelector() {
      return null;
    },
    addEventListener() {},
    removeEventListener() {},
  };
  const end = { scrollIntoView: (options) => scrolls.push(options) };
  const options = { session: { id: "fixture", cwd: "/fixture" }, newSessionCwd: null };
  function Probe() {
    current = useAgentSession(options);
    return createElement(
      "div",
      { ref: current.scrollContainerRef },
      createElement("span", { ref: current.messagesEndRef }),
    );
  }
  t.after(async () => {
    if (renderer) await act(async () => renderer.unmount());
    testApi.setHistory(undefined, undefined);
    for (const [name, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete globalThis[name];
    }
  });
  await act(async () => {
    renderer = create(createElement(Probe), {
      createNodeMock: (element) => (element.type === "div" ? container : end),
    });
  });
  assert.equal(current.messages.length, 1);
  assert.ok(scrolls.length > 0, "initial history still follows the existing initial-scroll policy");
  scrolls.length = 0;
  container.scrollTop = 300;
  await act(async () => current.loadOlder());
  assert.equal(current.messages.length, 2);
  assert.deepEqual(scrolls, [], "prepending must not call scrollIntoView on the bottom anchor");
  const pending = [...frames.values()];
  frames.clear();
  pending.forEach((callback) => callback());
  assert.equal(container.scrollTop, 2300);
});

for (const action of ["create", "fork"]) {
  test(`a late ${action} result cannot navigate a view the user already left`, async (t) => {
    testApi.resetCommands();
    const originals = new Map();
    const install = (name, value) => {
      originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
      Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
    };
    install("IS_REACT_ACT_ENVIRONMENT", true);
    install("window", { addEventListener() {}, removeEventListener() {}, localStorage: { getItem: () => "off" } });
    install("document", { visibilityState: "visible", addEventListener() {}, removeEventListener() {} });
    install("requestAnimationFrame", (callback) => {
      callback();
      return 0;
    });
    install("cancelAnimationFrame", () => {});
    let renderer, current;
    const navigations = [];
    const options = {
      session: null,
      newSessionCwd: action === "create" ? "/fixture" : null,
      onSessionCreated: (session) => navigations.push(session),
      onSessionForked: (id) => navigations.push(id),
    };
    function Probe() {
      current = useAgentSession(options);
      return null;
    }
    t.after(async () => {
      if (renderer) await act(async () => renderer.unmount());
      testApi.resetCommands();
      for (const [name, descriptor] of originals) {
        if (descriptor) Object.defineProperty(globalThis, name, descriptor);
        else delete globalThis[name];
      }
    });
    await act(async () => {
      renderer = create(createElement(Probe));
    });
    const pending = createDeferred();
    testApi.queueCommand(action === "create" ? "ensure_session" : "fork", pending.promise);
    testApi.queueCommand("prompt", {});
    let operation;
    await act(async () => {
      if (action === "fork") current.sessionIdRef.current = "source";
      operation = action === "create" ? current.handleSend("background fixture") : current.handleFork("entry");
    });
    await act(async () => renderer.unmount());
    renderer = null;
    await act(async () => {
      pending.resolve(action === "create" ? { sessionId: "new" } : { newSessionId: "forked" });
      await operation;
    });
    assert.deepEqual(navigations, []);
    assert.deepEqual(testApi.connections, [], "leaving the view must not install a background UI subscription");
    assert.equal(
      testApi.commands.filter(({ command }) => command.type === "prompt").length,
      action === "create" ? 1 : 0,
      "an already accepted prompt still executes exactly once after the view closes",
    );
  });
}
