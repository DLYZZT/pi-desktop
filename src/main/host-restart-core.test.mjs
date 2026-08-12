import assert from "node:assert/strict";
import test from "node:test";
import { reserveHostRestart, trySpawnHost } from "./host-restart-core.ts";

test("converts synchronous Host spawn exceptions into a result", () => {
  const expectedChild = { pid: 42 };

  assert.deepEqual(
    trySpawnHost(() => expectedChild),
    { ok: true, child: expectedChild },
  );
  assert.deepEqual(
    trySpawnHost(() => {
      throw new Error("fork unavailable");
    }),
    { ok: false, error: "fork unavailable" },
  );
  assert.deepEqual(
    trySpawnHost(() => {
      throw "unknown fork failure";
    }),
    { ok: false, error: "unknown fork failure" },
  );
});

test("bounds Host restart attempts inside a rolling crash window", () => {
  const first = reserveHostRestart([], 1_000, 30_000, 2);
  assert.deepEqual(first, { restartTimes: [1_000], attempt: 1 });

  const second = reserveHostRestart(first.restartTimes, 2_000, 30_000, 2);
  assert.deepEqual(second, { restartTimes: [1_000, 2_000], attempt: 2 });

  assert.deepEqual(reserveHostRestart(second.restartTimes, 3_000, 30_000, 2), {
    restartTimes: [1_000, 2_000],
    attempt: null,
  });
  assert.deepEqual(reserveHostRestart(second.restartTimes, 32_000, 30_000, 2), {
    restartTimes: [32_000],
    attempt: 1,
  });
});
