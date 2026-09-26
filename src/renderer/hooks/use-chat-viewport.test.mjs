import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { createElement } from "react";
import { act, create } from "react-test-renderer";
import { importTestBundle } from "#test-bundle";

const { useChatViewport } = await importTestBundle("chat-viewport-hook", {
  entryPoints: [path.join(import.meta.dirname, "useChatViewport.ts")],
  tsconfig: path.join(import.meta.dirname, "../../../tsconfig.renderer.json"),
  external: ["react", "react-dom", "react-dom/*"],
});

function eventTarget() {
  const listeners = new Map();
  return {
    addEventListener(type, listener) {
      const values = listeners.get(type) ?? new Set();
      values.add(listener);
      listeners.set(type, values);
    },
    removeEventListener(type, listener) {
      listeners.get(type)?.delete(listener);
    },
    emit(type, value) {
      for (const listener of listeners.get(type) ?? []) listener(value);
    },
    count() {
      return [...listeners.values()].reduce((total, values) => total + values.size, 0);
    },
  };
}

async function mount(t, { resetFollow = true } = {}) {
  const originals = new Map();
  const install = (name, value) => {
    originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  };
  const window = eventTarget();
  const observers = [];
  const frames = new Map();
  let sequence = 0,
    now = 10_000;
  t.mock.method(Date, "now", () => now);
  class Element {
    constructor(editable = false) {
      this.editable = editable;
    }
    closest() {
      return this.editable ? this : null;
    }
  }
  class KeyboardEvent {
    constructor(key, target = new Element()) {
      this.key = key;
      this.target = target;
    }
  }
  class WheelEvent {
    constructor(deltaY, ctrlKey = false) {
      this.deltaY = deltaY;
      this.ctrlKey = ctrlKey;
    }
  }
  class ResizeObserver {
    constructor(callback) {
      this.callback = callback;
      this.disconnected = false;
      observers.push(this);
    }
    observe() {}
    disconnect() {
      this.disconnected = true;
    }
  }
  install("IS_REACT_ACT_ENVIRONMENT", true);
  install("window", window);
  install("Element", Element);
  install("KeyboardEvent", KeyboardEvent);
  install("WheelEvent", WheelEvent);
  install("ResizeObserver", ResizeObserver);
  install("requestAnimationFrame", (callback) => {
    frames.set(++sequence, callback);
    return sequence;
  });
  install("cancelAnimationFrame", (id) => frames.delete(id));
  const calls = [];
  const container = Object.assign(eventTarget(), {
    scrollTop: 1400,
    scrollHeight: 2000,
    clientHeight: 600,
    querySelector() {
      return null;
    },
    getBoundingClientRect() {
      return { top: 0 };
    },
    scrollTo(options) {
      calls.push({ target: "user", ...options });
      this.scrollTop = options.top;
    },
  });
  const anchor = (name) => ({
    scrollIntoView(options) {
      calls.push({ target: name, ...options });
      container.scrollTop = container.scrollHeight - container.clientHeight;
    },
  });
  const live = anchor("live"),
    end = anchor("end");
  const user = { getBoundingClientRect: () => ({ top: 80 }) };
  const runningRef = { current: false };
  let options = {
    agentRunning: false,
    agentRunningRef: runningRef,
    agentPhase: null,
    streamState: { isStreaming: false, streamingMessage: null },
    messageCount: 1,
    loading: false,
  };
  let current,
    renderer,
    disposed = false;
  function Probe() {
    current = useChatViewport(options);
    return createElement(
      "div",
      { ref: current.scrollContainerRef },
      createElement("span", { kind: "live", ref: current.liveContentEndRef }),
      createElement("span", { kind: "end", ref: current.messagesEndRef }),
      createElement("span", { kind: "user", ref: current.lastUserMsgRef }),
    );
  }
  const unmount = async () => {
    if (renderer) await act(async () => renderer.unmount());
    renderer = null;
  };
  const dispose = async () => {
    if (disposed) return;
    disposed = true;
    await unmount();
    for (const [name, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete globalThis[name];
    }
  };
  t.after(dispose);
  await act(async () => {
    renderer = create(createElement(Probe), {
      createNodeMock: (element) => (element.type === "div" ? container : { live, end, user }[element.props.kind]),
    });
  });
  if (resetFollow) window.emit("keydown", new KeyboardEvent("ArrowUp"));
  calls.length = 0;
  return {
    get current() {
      return current;
    },
    window,
    container,
    calls,
    frames,
    observers,
    Element,
    KeyboardEvent,
    WheelEvent,
    unmount,
    dispose,
    advance: (ms) => {
      now += ms;
    },
    async update(patch) {
      options = { ...options, ...patch };
      runningRef.current = options.agentRunning;
      await act(async () => renderer.update(createElement(Probe)));
    },
    async flush() {
      await act(async () => {
        const pending = [...frames.values()];
        frames.clear();
        pending.forEach((callback) => callback());
      });
    },
  };
}

const stream = (text) => ({
  isStreaming: true,
  streamingMessage: { role: "assistant", content: [{ type: "text", text }] },
});

test("upward wheel intent releases streaming follow even inside the programmatic guard", async (t) => {
  const fixture = await mount(t);
  fixture.current.reattachAutoFollow();
  await fixture.update({ agentRunning: true, streamState: stream("one") });
  await fixture.flush();
  assert.ok(fixture.calls.some((call) => call.target === "live"));
  fixture.calls.length = 0;
  fixture.container.emit("wheel", new fixture.WheelEvent(-10));
  await fixture.update({ streamState: stream("two") });
  await fixture.flush();
  assert.deepEqual(fixture.calls, []);
  fixture.current.reattachAutoFollow();
  await fixture.update({ streamState: stream("three") });
  await fixture.flush();
  assert.ok(fixture.calls.some((call) => call.target === "live"));
});

test("editing cursor keys and pinch zoom do not permanently release follow", async (t) => {
  const fixture = await mount(t);
  fixture.current.reattachAutoFollow();
  await fixture.update({ agentRunning: true, streamState: stream("one") });
  await fixture.flush();
  fixture.calls.length = 0;
  fixture.window.emit("keydown", new fixture.KeyboardEvent("ArrowUp", new fixture.Element(true)));
  await fixture.update({ streamState: stream("two") });
  await fixture.flush();
  assert.ok(fixture.calls.some((call) => call.target === "live"));
  fixture.calls.length = 0;
  fixture.container.emit("wheel", new fixture.WheelEvent(-10, true));
  fixture.advance(2000);
  await fixture.update({ streamState: stream("three") });
  await fixture.flush();
  assert.ok(fixture.calls.some((call) => call.target === "live"));
});

test("external turns respect a reader away from the bottom and explicit touch gestures", async (t) => {
  const fixture = await mount(t);
  fixture.container.scrollTop = 100;
  fixture.current.beginExternalTurn();
  await fixture.update({ agentRunning: true, streamState: stream("one") });
  await fixture.flush();
  assert.deepEqual(fixture.calls, []);
  fixture.current.reattachAutoFollow();
  fixture.calls.length = 0;
  fixture.container.emit("touchstart", { touches: [{ clientY: 100 }] });
  fixture.container.emit("touchmove", { touches: [{ clientY: 130 }] });
  fixture.container.emit("touchend", { touches: [] });
  fixture.advance(2000);
  await fixture.update({ streamState: stream("two") });
  await fixture.flush();
  assert.deepEqual(fixture.calls, []);
});

test("prepend anchors yield to new local turns and cannot write after unmount", async (t) => {
  const fixture = await mount(t);
  fixture.container.scrollTop = 300;
  const restore = fixture.current.capturePrependAnchor();
  fixture.container.scrollHeight = 2400;
  restore();
  assert.equal(fixture.container.scrollTop, 700);
  const superseded = fixture.current.capturePrependAnchor();
  fixture.current.beginLocalTurn();
  fixture.container.scrollHeight = 2800;
  superseded();
  assert.equal(fixture.container.scrollTop, 700);
  await fixture.update({ messageCount: 2, agentRunning: true });
  assert.ok(fixture.calls.some((call) => call.target === "user"));
  const stopped = fixture.current.capturePrependAnchor();
  await fixture.unmount();
  fixture.container.scrollTop = 50;
  fixture.container.scrollHeight = 3200;
  stopped();
  assert.equal(fixture.container.scrollTop, 50);
});

test("explicit reattachment overrides a pending history anchor", async (t) => {
  const fixture = await mount(t);
  fixture.container.scrollTop = 300;
  const restore = fixture.current.capturePrependAnchor();
  fixture.current.reattachAutoFollow();
  fixture.calls.length = 0;
  fixture.container.scrollHeight = 2400;
  await fixture.update({ messageCount: 2 });
  assert.ok(fixture.calls.some((call) => call.target === "end"));
  const followedTop = fixture.container.scrollTop;
  restore();
  assert.equal(fixture.container.scrollTop, followedTop);
});

test("unmount removes listeners, observers and delayed restore callbacks", async (t) => {
  const fixture = await mount(t);
  fixture.current.reattachAutoFollow();
  fixture.calls.length = 0;
  fixture.current.restoreFollowAfterLoad();
  const queued = [...fixture.frames.values()];
  assert.ok(queued.length > 0);
  assert.ok(fixture.window.count() + fixture.container.count() > 0);
  await fixture.unmount();
  queued.forEach((callback) => callback());
  fixture.current.reattachAutoFollow();
  assert.deepEqual(fixture.calls, []);
  assert.equal(fixture.frames.size, 0);
  assert.equal(fixture.window.count() + fixture.container.count(), 0);
  assert.ok(fixture.observers.every((observer) => observer.disconnected));
});

test("an explicitly attached follow preference survives a view remount", async (t) => {
  const first = await mount(t);
  first.current.reattachAutoFollow();
  await first.dispose();
  const next = await mount(t, { resetFollow: false });
  next.calls.length = 0;
  next.current.prepareSessionChange();
  next.current.restoreFollowAfterLoad();
  await next.flush();
  await next.flush();
  assert.equal(next.calls.filter((call) => call.target === "end").length, 2);
});
