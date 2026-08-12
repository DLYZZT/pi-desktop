import assert from "node:assert/strict";
import test from "node:test";

import { persistSoundEnabled, readSoundEnabled } from "./useAudio.ts";

test("sound preference defaults to enabled when storage is empty or unavailable", () => {
  assert.equal(readSoundEnabled({ getItem: () => null }), true);
  assert.equal(
    readSoundEnabled({
      getItem() {
        throw Object.assign(new Error("blocked"), { name: "SecurityError" });
      },
    }),
    true,
  );
});

test("sound preference preserves stored boolean semantics", () => {
  assert.equal(readSoundEnabled({ getItem: () => "true" }), true);
  assert.equal(readSoundEnabled({ getItem: () => "false" }), false);
});

test("sound preference writes are best effort", () => {
  const writes = [];
  persistSoundEnabled(false, { setItem: (key, value) => writes.push([key, value]) });
  assert.deepEqual(writes, [["pi-sound-enabled", "false"]]);

  assert.doesNotThrow(() =>
    persistSoundEnabled(true, {
      setItem() {
        throw Object.assign(new Error("full"), { name: "QuotaExceededError" });
      },
    }),
  );
});
