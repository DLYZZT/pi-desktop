import assert from "node:assert/strict";
import test from "node:test";
import { createSessionEventBindings } from "./session-event-bindings.ts";

function source(id = "session") {
  const calls = { events: 0, closed: 0, destroyOff: 0 };
  let event, destroy;
  const instance = {
    sessionId: id,
    onEvent(listener) {
      calls.events++;
      event = listener;
      return () => calls.closed++;
    },
    onDestroy(listener) {
      destroy = listener;
      return () => calls.destroyOff++;
    },
  };
  return { instance, calls, emit: (value) => event(value), destroy: () => destroy() };
}

test("one source binds once and only SDK agent_end sends the completion notification", () => {
  const events = [],
    notifications = [],
    fixture = source();
  const registry = createSessionEventBindings({ emit: (...event) => events.push(event) }, (id) =>
    notifications.push(id),
  );
  registry.ensure(fixture.instance, "fallback");
  registry.ensure(fixture.instance, "fallback");
  fixture.emit({ type: "prompt_done" });
  fixture.emit({ type: "agent_end" });
  assert.equal(fixture.calls.events, 1);
  assert.equal(events.length, 2);
  assert.deepEqual(notifications, ["session"]);
  registry.close();
  registry.close();
  assert.equal(fixture.calls.closed, 1);
  assert.equal(fixture.calls.destroyOff, 1);
});

test("late events or destruction from the old wrapper cannot retire its replacement", () => {
  const events = [],
    first = source(),
    next = source();
  const registry = createSessionEventBindings({ emit: (...event) => events.push(event) }, () => {});
  registry.ensure(first.instance, "session");
  registry.ensure(next.instance, "session");
  first.destroy();
  first.emit({ type: "ghost" });
  next.emit({ type: "current" });
  assert.equal(first.calls.closed, 1);
  assert.equal(next.calls.closed, 0);
  assert.deepEqual(
    events.map((event) => event[2].type),
    ["current"],
  );
  registry.close();
  next.emit({ type: "after close" });
  registry.ensure(source().instance, "new");
  assert.equal(next.calls.closed, 1);
  assert.equal(events.length, 1);
});

test("a synchronous destroy during installation still releases both returned handles", () => {
  let eventsClosed = 0,
    destroyClosed = 0;
  const registry = createSessionEventBindings({ emit() {} }, () => {});
  registry.ensure(
    {
      sessionId: "session",
      onEvent() {
        return () => eventsClosed++;
      },
      onDestroy(callback) {
        callback();
        return () => destroyClosed++;
      },
    },
    "session",
  );
  registry.close();
  assert.equal(eventsClosed, 1);
  assert.equal(destroyClosed, 1);
});

test("failed installation can retry and one bad release does not prevent other cleanup", () => {
  const registry = createSessionEventBindings({ emit() {} }, () => {});
  const broken = source("broken"),
    valid = source("valid");
  const original = broken.instance.onEvent;
  broken.instance.onEvent = () => {
    throw new Error("install failed");
  };
  assert.throws(() => registry.ensure(broken.instance, "broken"), /install failed/);
  broken.instance.onEvent = (listener) => {
    original(listener);
    return () => {
      broken.calls.closed++;
      throw new Error("release failed");
    };
  };
  registry.ensure(broken.instance, "broken");
  registry.ensure(valid.instance, "valid");
  registry.close();
  assert.equal(broken.calls.closed, 1);
  assert.equal(valid.calls.closed, 1);
});
