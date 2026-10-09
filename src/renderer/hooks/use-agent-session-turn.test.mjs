import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { createElement } from "react";
import { act, create } from "react-test-renderer";
import { importTestBundle } from "#test-bundle";
import { createDeferred } from "#test-timing";

const { useAgentSession, testApi, SessionPresentationStore } = await importTestBundle("session-turn-hook", {
  stdin: {
    contents:
      'export { useAgentSession } from "./useAgentSession.ts"; export * as testApi from "@/lib/api-client"; export {SessionPresentationStore} from "@/lib/session-presentation-store";',
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
          let stateResponse;
          export function setStateResponse(value) { stateResponse = value; }
          export async function agentState() { return stateResponse ?? { running: false }; }
          export const connections = [];
          export async function subscribeAgentEvents(sid) { connections.push(sid); return () => {}; }
          const changeListeners = new Set();
          export function emitChanges(event) { for (const listener of changeListeners) listener(event); }
          export async function subscribeSessionsChanged(listener) { changeListeners.add(listener); return () => changeListeners.delete(listener); }
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
          export let historyReads = 0;
          export function resetCommands() { pendingCommands.clear(); commands.length = connections.length = historyReads = 0; }
          let detail, page;
          export function setHistory(nextDetail, nextPage) { detail = nextDetail; page = nextPage; }
          export async function getSession() { historyReads++; if (!detail) throw new Error("unexpected detail read"); return detail; }
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

const runtimeDetail = (runtime, messages = []) => ({
  sessionId: "fixture",
  info: { id: "fixture", cwd: "/fixture" },
  leafId: null,
  tree: [],
  context: {
    messages,
    entryIds: messages.map((_, i) => String(i)),
    historyRevision: "r1",
    model: null,
    thinkingLevel: "off",
    loadedMessages: messages.length,
    totalMessages: messages.length,
    truncatedBefore: false,
  },
  agentState: runtime,
});

async function mountRuntime(t, initial, overrides = {}) {
  const originals = new Map();
  const listeners = new Map();
  const install = (name, value) => {
    originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  };
  install("IS_REACT_ACT_ENVIRONMENT", true);
  install("window", {
    addEventListener: (name, callback) => {
      const set = listeners.get(name) ?? new Set();
      set.add(callback);
      listeners.set(name, set);
    },
    removeEventListener: (name, callback) => listeners.get(name)?.delete(callback),
  });
  install("document", { visibilityState: "visible", addEventListener() {}, removeEventListener() {} });
  install("requestAnimationFrame", (callback) => {
    callback();
    return 0;
  });
  install("cancelAnimationFrame", () => {});
  testApi.resetCommands();
  testApi.setStateResponse(undefined);
  testApi.queueCommand("get_tools", []);
  testApi.setHistory(initial, undefined);
  let current,
    renderer,
    completions = 0;
  const options = {
    session: { id: "fixture", cwd: "/fixture" },
    newSessionCwd: null,
    onAgentEnd: () => completions++,
    ...overrides,
  };
  function Probe() {
    current = useAgentSession(options);
    return null;
  }
  t.after(async () => {
    if (renderer) await act(async () => renderer.unmount());
    testApi.resetCommands();
    testApi.setStateResponse(undefined);
    testApi.setHistory(undefined, undefined);
    for (const [name, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete globalThis[name];
    }
  });
  await act(async () => {
    renderer = create(createElement(Probe));
  });
  return {
    get current() {
      return current;
    },
    get completions() {
      return completions;
    },
    emit: (event) => act(async () => current.handleAgentEventRef.current(event)),
    reconcile: () =>
      act(async () => {
        for (const listener of listeners.get("online") ?? []) listener();
      }),
    async unmount() {
      if (renderer) await act(async () => renderer.unmount());
      renderer = null;
    },
  };
}

test("an initial running snapshot arriving after prompt_done cannot resurrect the turn", async (t) => {
  const initial = createDeferred();
  const fixture = await mountRuntime(t, initial.promise);
  await fixture.emit({ type: "prompt_done" });
  await act(async () => {
    initial.resolve(runtimeDetail({ running: true, state: { isStreaming: true } }));
  });
  assert.equal(fixture.current.agentRunning, false);
  assert.equal(fixture.current.streamState.isStreaming, false);
});

test("a resumed view accepts completion from the client run created by its previous mount", async (t) => {
  const fixture = await mountRuntime(t, runtimeDetail({ running: true, state: { isStreaming: true } }));
  assert.equal(fixture.current.agentRunning, true);
  testApi.setHistory(
    runtimeDetail({ running: true, state: { isStreaming: false, isPromptRunning: false } }),
    undefined,
  );
  await fixture.emit({ type: "prompt_done", clientRunId: 42 });
  assert.equal(fixture.current.agentRunning, false);
  assert.equal(fixture.completions, 1);
});

test("SDK cancellation marks completion as aborted without ending the enclosing prompt early", async (t) => {
  const outcomes = [];
  const fixture = await mountRuntime(
    t,
    runtimeDetail({ running: true, state: { isStreaming: true, isPromptRunning: true } }),
    {
      onAgentEnd: (aborted) => outcomes.push(aborted),
    },
  );
  await fixture.emit({ type: "agent_settled", aborted: true });
  assert.equal(fixture.current.agentRunning, true);
  assert.deepEqual(outcomes, []);
  testApi.setHistory(
    runtimeDetail({
      running: true,
      state: { isStreaming: false, isPromptRunning: false, agentSettled: { aborted: true } },
    }),
    undefined,
  );
  await fixture.emit({ type: "prompt_error", aborted: true, errorMessage: "Aborted" });
  await fixture.emit({ type: "prompt_done" });
  await fixture.emit({ type: "prompt_done" });
  assert.equal(fixture.current.agentRunning, false);
  assert.deepEqual(outcomes, [true]);
  assert.ok(!fixture.current.notices.some((notice) => notice.message === "Aborted"));
  await fixture.emit({ type: "agent_start" });
  await fixture.emit({ type: "agent_settled", aborted: false });
  testApi.setHistory(
    runtimeDetail({
      running: true,
      state: { isStreaming: false, isPromptRunning: false, agentSettled: { aborted: false } },
    }),
    undefined,
  );
  await fixture.emit({ type: "prompt_done" });
  assert.deepEqual(outcomes, [true, false]);
});

test("state reconciliation retains cancellation when its settlement stream event was missed", async (t) => {
  const outcomes = [];
  const fixture = await mountRuntime(t, runtimeDetail({ running: true, state: { isStreaming: true } }), {
    onAgentEnd: (aborted) => outcomes.push(aborted),
  });
  const idle = {
    running: true,
    state: { isStreaming: false, isPromptRunning: false, agentSettled: { aborted: true } },
  };
  testApi.setStateResponse(idle);
  testApi.setHistory(runtimeDetail(idle), undefined);
  await fixture.reconcile();
  assert.equal(fixture.current.agentRunning, false);
  assert.deepEqual(outcomes, [true]);
});

test("local client IDs still reject unrelated completion and cannot stop a later channel turn", async (t) => {
  const fixture = await mountRuntime(t, runtimeDetail({ running: false }));
  testApi.queueCommand("prompt", {});
  await act(async () => fixture.current.handleSend("local fixture"));
  await fixture.emit({ type: "agent_start" });
  await fixture.emit({ type: "prompt_done", clientRunId: 99 });
  assert.equal(fixture.current.agentRunning, true);
  assert.equal(fixture.completions, 0);
  await fixture.emit({ type: "prompt_done", clientRunId: 1 });
  assert.equal(fixture.current.agentRunning, false);
  assert.equal(fixture.completions, 1);
  await fixture.emit({ type: "channel_turn_start", runId: "external" });
  await fixture.emit({ type: "agent_start" });
  await fixture.emit({ type: "prompt_done", clientRunId: 1 });
  assert.equal(fixture.current.agentRunning, true);
  assert.equal(fixture.completions, 1);
});

test("a newer history-only refresh does not discard the initial runtime hydration", async (t) => {
  const initial = createDeferred();
  const fixture = await mountRuntime(t, initial.promise);
  const message = { role: "user", content: "newer persisted history" };
  testApi.setHistory(runtimeDetail(undefined, [message]), undefined);
  await act(async () => testApi.emitChanges({ sessionId: "fixture" }));
  assert.deepEqual(fixture.current.messages, [message]);
  await act(async () => {
    initial.resolve(runtimeDetail({ running: true, state: { isStreaming: true, systemPrompt: "initial" } }));
  });
  assert.equal(fixture.current.agentRunning, true);
  assert.equal(fixture.current.systemPrompt, "initial");
  assert.deepEqual(fixture.current.messages, [message]);
});

test("an initial snapshot hydrates the run while preserving newer queue, compaction and extension events", async (t) => {
  const initial = createDeferred();
  const fixture = await mountRuntime(t, initial.promise);
  await fixture.emit({ type: "queue_update", steering: ["new"], followUp: [] });
  await fixture.emit({ type: "compaction_start" });
  await fixture.emit({ type: "extension_ui_request", method: "setStatus", statusKey: "job", statusText: "new" });
  await fixture.emit({ type: "extension_ui_request", method: "setWidget", widgetKey: "job", widgetLines: ["new"] });
  await act(async () => {
    initial.resolve(
      runtimeDetail({
        running: true,
        state: {
          isStreaming: true,
          isCompacting: false,
          queuedMessages: { steering: ["old"], followUp: [] },
          extensionStatuses: [{ key: "job", text: "old" }],
          extensionWidgets: [],
        },
      }),
    );
  });
  assert.equal(fixture.current.agentRunning, true, "unrelated fields must not discard initial run hydration");
  assert.deepEqual(fixture.current.queuedMessages, { steering: ["new"], followUp: [] });
  assert.equal(fixture.current.isCompacting, true);
  assert.deepEqual(fixture.current.extensionStatuses, [{ key: "job", text: "new" }]);
  assert.deepEqual(fixture.current.extensionWidgets[0].lines, ["new"]);
});

test("an older initial snapshot cannot clear a newer stream projection", async (t) => {
  const initial = createDeferred();
  const fixture = await mountRuntime(t, initial.promise);
  await fixture.emit({ type: "agent_start" });
  const message = { role: "assistant", content: [{ type: "text", text: "new stream" }] };
  await fixture.emit({ type: "message_update", message });
  await act(async () => {
    initial.resolve(runtimeDetail({ running: true, state: { isStreaming: true } }));
  });
  assert.deepEqual(fixture.current.streamState.streamingMessage, message);
  assert.equal(fixture.current.agentPhase, null);
});

test("a slow external completion cannot replace history or settle the next external run", async (t) => {
  const fixture = await mountRuntime(t, runtimeDetail({ running: false }));
  await fixture.emit({ type: "channel_turn_start", runId: "first" });
  await fixture.emit({ type: "agent_start" });
  const finishing = createDeferred();
  testApi.setHistory(finishing.promise, undefined);
  await fixture.emit({ type: "channel_turn_end", runId: "first" });
  await fixture.emit({ type: "channel_turn_start", runId: "second" });
  await fixture.emit({ type: "agent_start" });
  const message = { role: "user", content: "new external turn" };
  await fixture.emit({ type: "message_end", message });
  await act(async () => {
    finishing.resolve(runtimeDetail({ running: false }));
  });
  assert.equal(fixture.current.agentRunning, true);
  assert.deepEqual(fixture.current.messages, [message]);
  assert.equal(fixture.completions, 0);
  testApi.setHistory(runtimeDetail({ running: false }, [message]), undefined);
  await fixture.emit({ type: "channel_turn_end", runId: "second" });
  assert.equal(fixture.current.agentRunning, false);
  assert.equal(fixture.completions, 1);
});

test("an idle reconciliation read cannot override events received while it was in flight", async (t) => {
  const fixture = await mountRuntime(t, runtimeDetail({ running: false }));
  await fixture.emit({ type: "agent_start" });
  const state = createDeferred();
  testApi.setStateResponse(state.promise);
  await fixture.reconcile();
  await fixture.emit({ type: "queue_update", steering: ["keep"], followUp: [] });
  await fixture.emit({ type: "compaction_start" });
  await act(async () => {
    state.resolve({ running: true, state: { isStreaming: false, isPromptRunning: false, isCompacting: false } });
  });
  assert.equal(fixture.current.agentRunning, true);
  assert.equal(fixture.current.isCompacting, true);
  assert.deepEqual(fixture.current.queuedMessages.steering, ["keep"]);
  assert.equal(fixture.completions, 0);
});

test("running views coalesce persisted changes and prompt completion immediately reconciles the final history", async (t) => {
  const fixture = await mountRuntime(t, runtimeDetail({ running: true, state: { isStreaming: true } }));
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const initialReads = testApi.historyReads;
  const message = { role: "assistant", content: [{ type: "text", text: "persisted" }] };
  testApi.setHistory(runtimeDetail({ running: false }, [message]), undefined);
  await act(async () => {
    for (let i = 0; i < 100; i++) testApi.emitChanges({ sessionId: "fixture" });
  });
  assert.equal(testApi.historyReads, initialReads);
  await act(async () => t.mock.timers.tick(1000));
  assert.equal(testApi.historyReads, initialReads + 1);
  assert.deepEqual(fixture.current.messages, [message]);
  await act(async () => testApi.emitChanges({ sessionId: "fixture" }));
  await fixture.emit({ type: "prompt_done" });
  assert.equal(testApi.historyReads, initialReads + 2);
  assert.equal(fixture.current.agentRunning, false);
  await act(async () => t.mock.timers.tick(1000));
  assert.equal(testApi.historyReads, initialReads + 2, "completion cancels the pending redundant read");
});

for (const action of ["recall", "stats", "tools"]) {
  test(`a late ${action} result cannot mutate the next view's shared UI`, async (t) => {
    const effects = [],
      pending = createDeferred();
    const input = { current: { prependText: (text) => effects.push(text) } };
    const fixture = await mountRuntime(t, runtimeDetail({ running: false }), {
      chatInputRef: input,
      onSessionStatsPanelOpen: () => effects.push("open stats"),
      setToolPreset: (value) => effects.push(value),
    });
    const initialEffects = [...effects];
    const type = { recall: "clear_queue", stats: "get_session_stats", tools: "get_tools" }[action];
    testApi.queueCommand(type, pending.promise);
    let operation;
    await act(async () => {
      operation =
        action === "recall"
          ? fixture.current.handleRecallQueue()
          : action === "stats"
            ? fixture.current.handleBuiltinSlashCommand("/session")
            : fixture.current.loadTools("fixture");
    });
    await fixture.unmount();
    input.current = { prependText: (text) => effects.push("new view: " + text) };
    await act(async () => {
      pending.resolve(
        action === "recall" ? { steering: ["old draft"] } : action === "tools" ? [] : { sessionName: "old" },
      );
      await operation;
    });
    assert.deepEqual(effects, initialEffects);
  });
}

test("an older command-directory failure cannot clear the newer loading owner", async (t) => {
  const fixture = await mountRuntime(t, runtimeDetail({ running: false }));
  const old = createDeferred(),
    next = createDeferred();
  let first, second;
  await act(async () => {
    testApi.queueCommand("get_commands", old.promise);
    first = fixture.current.loadSlashCommands();
    testApi.queueCommand("get_commands", next.promise);
    second = fixture.current.loadSlashCommands();
  });
  assert.equal(fixture.current.slashCommandsLoading, true);
  await act(async () => {
    old.reject(new Error("late old failure"));
    await first;
  });
  assert.equal(fixture.current.slashCommandsLoading, true);
  const commands = [{ name: "new", source: "extension" }];
  await act(async () => {
    next.resolve({ commands });
    await second;
  });
  assert.deepEqual(fixture.current.slashCommands, commands);
  assert.equal(fixture.current.slashCommandsLoading, false);
});

test("an older model-selection response cannot overwrite the newer displayed choice", async (t) => {
  const fixture = await mountRuntime(t, runtimeDetail({ running: false }));
  const old = createDeferred(),
    next = createDeferred();
  let first, second;
  await act(async () => {
    testApi.queueCommand("set_model", old.promise);
    first = fixture.current.handleModelChange("p", "old");
    testApi.queueCommand("set_model", next.promise);
    second = fixture.current.handleModelChange("p", "new");
  });
  await act(async () => {
    next.resolve({});
    await second;
  });
  await act(async () => {
    old.resolve({});
    await first;
  });
  assert.deepEqual(fixture.current.currentModel, { provider: "p", modelId: "new" });
});

test("two submit callbacks before the next render still send only one prompt", async (t) => {
  const fixture = await mountRuntime(t, runtimeDetail({ running: false }));
  testApi.queueCommand("prompt", {});
  await act(async () => Promise.all([fixture.current.handleSend("same"), fixture.current.handleSend("same")]));
  assert.equal(testApi.commands.filter(({ command }) => command.type === "prompt").length, 1);
  assert.equal(fixture.current.messages.length, 1);
});

test("queue recall restores its text without clearing a newer queue event", async (t) => {
  const restored = [],
    pending = createDeferred();
  const fixture = await mountRuntime(t, runtimeDetail({ running: false }), {
    chatInputRef: { current: { prependText: (text) => restored.push(text) } },
  });
  testApi.queueCommand("clear_queue", pending.promise);
  let recall;
  await act(async () => {
    recall = fixture.current.handleRecallQueue();
  });
  await fixture.emit({ type: "queue_update", steering: ["new queued message"], followUp: [] });
  await act(async () => {
    pending.resolve({ steering: ["recalled"] });
    await recall;
  });
  assert.deepEqual(fixture.current.queuedMessages.steering, ["new queued message"]);
  assert.deepEqual(restored, ["recalled"]);
});

test("unmount cancels the actual slash-command settlement wait and all view timers", async (t) => {
  const timers = new Map();
  let sequence = 0;
  t.mock.method(globalThis, "setTimeout", (callback, delay) => {
    const id = ++sequence;
    timers.set(id, { callback, delay });
    return id;
  });
  t.mock.method(globalThis, "clearTimeout", (id) => timers.delete(id));
  const fixture = await mountRuntime(t, runtimeDetail({ running: false }));
  testApi.queueCommand("prompt", {});
  await act(async () => fixture.current.handleSend("/fixture-extension"));
  assert.ok([...timers.values()].some((timer) => timer.delay === 800));
  await fixture.unmount();
  assert.equal(timers.size, 0);
});

test("session presentation publishes the latest persisted title instead of the selection-time name", async (t) => {
  const presentationStore = new SessionPresentationStore();
  const detail = runtimeDetail({ running: false });
  detail.info.name = "persisted title";
  detail.stats = { sessionId: "fixture", sessionName: "persisted title", tokens: { input: 7 } };
  const fixture = await mountRuntime(t, detail, {
    presentationStore,
    session: { id: "fixture", cwd: "/fixture", name: "selection-time title" },
  });
  assert.equal(presentationStore.getSnapshot().info.name, "persisted title");
  assert.equal(presentationStore.getSnapshot().stats.sessionName, "persisted title");
  testApi.setHistory({ ...detail, info: { ...detail.info, name: "generated title" } }, undefined);
  await act(async () => testApi.emitChanges({ sessionId: "fixture" }));
  assert.equal(presentationStore.getSnapshot().info.name, "generated title");
  assert.equal(presentationStore.getSnapshot().stats.sessionName, "generated title");
  assert.equal(presentationStore.getSnapshot().stats.tokens.input, 7);
  await fixture.unmount();
  assert.equal(presentationStore.getSnapshot(), null);
});
