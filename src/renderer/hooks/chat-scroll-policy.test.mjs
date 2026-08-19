import { importTestBundle } from "#test-bundle";
import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

const { didUserScrollUp, isNearChatBottom, shouldDisengageScrollMagnet, shouldStopChatAutoFollow } =
  await importTestBundle("src/renderer/hooks/chat-scroll-policy", {
    entryPoints: [path.join(import.meta.dirname, "chat-scroll-policy.ts")],
  });

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

test("run spacer must not count as content: bottom stays near even with a full-viewport spacer", () => {
  // Without the spacer correction, a live run at content end looks "away from
  // bottom" (scrollHeight is inflated by one viewport) and the badge lingers.
  const metrics = { scrollTop: 1_000, scrollHeight: 2_000, clientHeight: 500 };
  assert.equal(isNearChatBottom(metrics), false, "raw metrics say away");
  assert.equal(isNearChatBottom({ ...metrics, spacerHeight: 500 }), true, "spacer excluded: content end reached");
  assert.equal(isNearChatBottom({ ...metrics, spacerHeight: 0 }), false, "zero spacer keeps raw behavior");
  // Scrolled past content into the spacer itself still counts as bottom.
  assert.equal(isNearChatBottom({ scrollTop: 1_500, scrollHeight: 2_000, clientHeight: 500, spacerHeight: 500 }), true);
});

test("explicit upward input disengages the scroll magnet during a session transition", () => {
  const decision = {
    previousScrollTop: 900,
    currentScrollTop: 800,
    now: 1_000,
    userIntentUntil: 1_500,
    sessionChangeIgnoreUntil: 2_000,
  };

  assert.equal(shouldDisengageScrollMagnet(decision), true, "explicit input must beat the transition guard");
  assert.equal(
    shouldDisengageScrollMagnet({ ...decision, userIntentUntil: 999 }),
    false,
    "synthetic scrolls remain ignored during the transition",
  );
  assert.equal(
    shouldDisengageScrollMagnet({ ...decision, now: 2_000, userIntentUntil: 999 }),
    true,
    "upward movement is trusted again after the transition",
  );
  assert.equal(shouldDisengageScrollMagnet({ ...decision, currentScrollTop: 950 }), false);
});
