import assert from "node:assert/strict";
import test from "node:test";

import { readCockpitRole } from "./cockpit.ts";

test("hash selects left or right cockpit; anything else is the old full shell", () => {
  assert.equal(readCockpitRole("#cockpit-left"), "left");
  assert.equal(readCockpitRole("#cockpit-right"), "right");
  assert.equal(readCockpitRole(""), "full");
  assert.equal(readCockpitRole("#settings"), "full");
});
