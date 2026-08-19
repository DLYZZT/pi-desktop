import assert from "node:assert/strict";
import test from "node:test";

import { isChannelInboundEnabled } from "./policy.ts";

test("channel inbound is off while the live agent is the external TUI", () => {
  assert.equal(isChannelInboundEnabled(), false);
});
