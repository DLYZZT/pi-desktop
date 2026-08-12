import { importTestBundle } from "#test-bundle";
import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

const { didUserScrollUp, isNearChatBottom, shouldStopChatAutoFollow } = await importTestBundle(
  "src/renderer/hooks/chat-scroll-policy",
  {
    entryPoints: [path.join(import.meta.dirname, "chat-scroll-policy.ts")],
  },
);

test("external-turn follow starts near the bottom and stops only for a meaningful upward scroll", () => {
  assert.equal(isNearChatBottom({ scrollTop: 1_000, scrollHeight: 1_500, clientHeight: 500 }), true);
  assert.equal(isNearChatBottom({ scrollTop: 804, scrollHeight: 1_400, clientHeight: 500 }), true);
  assert.equal(isNearChatBottom({ scrollTop: 803, scrollHeight: 1_400, clientHeight: 500 }), false);
  assert.equal(isNearChatBottom({ scrollTop: 0, scrollHeight: 0, clientHeight: 0 }), true);

  assert.equal(didUserScrollUp(900, 898), true);
  assert.equal(didUserScrollUp(900, 899), false);
  assert.equal(didUserScrollUp(900, 940), false);

  const decision = {
    previousScrollTop: 900,
    currentScrollTop: 850,
    now: 1_000,
    userIntentUntil: 2_000,
    programmaticScrollUntil: 1_500,
    externalAutoFollow: true,
  };
  assert.equal(shouldStopChatAutoFollow(decision), true, "upward input must beat an external follow frame");
  assert.equal(
    shouldStopChatAutoFollow({ ...decision, externalAutoFollow: false }),
    false,
    "local programmatic positioning must remain ignored",
  );
  assert.equal(shouldStopChatAutoFollow({ ...decision, userIntentUntil: 999 }), false);
  assert.equal(shouldStopChatAutoFollow({ ...decision, currentScrollTop: 950 }), false);
});
