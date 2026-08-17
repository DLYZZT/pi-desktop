import assert from "node:assert/strict";
import test from "node:test";

import { forkAllowOfficialUpdater } from "./updates.ts";

test("fork never takes official DLYZZT auto-updates", () => {
  assert.equal(forkAllowOfficialUpdater(), false);
});
