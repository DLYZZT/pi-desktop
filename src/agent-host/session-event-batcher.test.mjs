import assert from "node:assert/strict";
import test from "node:test";
import { SessionEventBatcher } from "./session-event-batcher.ts";

function fixture() {
  let now = 0;
  const timers = new Map();
  const events = [];
  const batcher = new SessionEventBatcher((event) => events.push(structuredClone(event)), {
    now: () => now,
    schedule: (flush, delay) => {
      const token = {};
      timers.set(token, { at: now + delay, flush });
      return () => timers.delete(token);
    },
  });
  return {
    batcher,
    events,
    timers,
    tick(ms) {
      now += ms;
      for (const [token, timer] of [...timers])
        if (timer.at <= now) {
          timers.delete(token);
          timer.flush();
        }
    },
  };
}
const update = (text) => ({
  type: "message_update",
  message: { role: "assistant", content: [{ type: "text", text }] },
  assistantMessageEvent: { type: "text_delta", partial: {} },
});

test("dense updates retain the complete latest snapshot at a bounded rate", () => {
  const f = fixture();
  f.batcher.push(update("first"));
  f.tick(5);
  for (let i = 0; i < 1000; i++) f.batcher.push(update(`latest ${i}`));
  assert.equal(f.events.length, 1);
  assert.equal(f.timers.size, 1);
  f.tick(45);
  assert.equal(f.events.length, 2);
  assert.equal(f.events[1].message.content[0].text, "latest 999");
  assert.equal("assistantMessageEvent" in f.events[1], false);
  f.batcher.dispose();
});

test("message, tool and completion boundaries flush pending content before the boundary", () => {
  const f = fixture();
  f.batcher.push(update("first"));
  f.batcher.push(update("complete tool arguments"));
  f.batcher.push({ type: "message_end", message: { role: "assistant" } });
  f.batcher.push({ type: "tool_execution_start", toolCallId: "call" });
  f.batcher.push({ type: "agent_end" });
  assert.deepEqual(
    f.events.map((event) => event.type),
    ["message_update", "message_update", "message_end", "tool_execution_start", "agent_end"],
  );
  assert.equal(f.events[1].message.content[0].text, "complete tool arguments");
  assert.equal(f.timers.size, 0);
  f.batcher.push({ type: "message_start", message: { role: "assistant" } });
  f.batcher.push(update("new message"));
  assert.equal(f.events.at(-1).message.content[0].text, "new message");
  f.batcher.dispose();
});

test("closing a binding discards queued updates and releases the timer", () => {
  const f = fixture();
  f.batcher.push(update("first"));
  f.batcher.push(update("late"));
  f.batcher.dispose();
  f.tick(100);
  f.batcher.push(update("after disposal"));
  assert.equal(f.events.length, 1);
  assert.equal(f.timers.size, 0);
});
