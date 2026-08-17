import assert from "node:assert/strict";
import test from "node:test";

import { forkNoticeDurationMs } from "./notices.ts";
import { forkStatusBarStatuses, forkUsageChips, isForkUsageChip } from "./usage.ts";

test("usage chips keep SuperGrok and drop MCP", () => {
  const statuses = [
    { key: "pi-grok-usage", text: "SuperGrok 98%" },
    { key: "mcp", text: "MCP: 2 servers enabled (2 connected)" },
    { key: "other", text: "ready" },
  ];
  assert.deepEqual(
    forkUsageChips(statuses).map((item) => item.key),
    ["pi-grok-usage"],
  );
  assert.deepEqual(
    forkStatusBarStatuses(statuses).map((item) => item.key),
    ["mcp", "other"],
  );
  assert.equal(isForkUsageChip({ key: "usage", text: "74%" }), true);
});

test("long or multiline notices stay up longer", () => {
  assert.equal(forkNoticeDurationMs("ok"), 5_000);
  assert.equal(forkNoticeDurationMs("line\nline"), 20_000);
  assert.equal(forkNoticeDurationMs("x".repeat(81)), 20_000);
});
