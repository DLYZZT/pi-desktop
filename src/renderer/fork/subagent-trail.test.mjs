import assert from "node:assert/strict";
import test from "node:test";

import { parseSubagentTrail } from "./subagent-trail.ts";

function assistantItems(items) {
  return [
    {
      role: "assistant",
      content: items.map((item) =>
        item.type === "toolCall"
          ? { type: "toolCall", name: item.name, arguments: item.args ?? {} }
          : { type: "text", text: item.text },
      ),
    },
  ];
}

function result(overrides = {}) {
  return {
    agent: "scout",
    agentSource: "user",
    task: "find auth",
    exitCode: 0,
    messages: [],
    stderr: "",
    usage: { input: 10, output: 4, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 1 },
    ...overrides,
  };
}

test("single live details with grep is a live trail", () => {
  const trail = parseSubagentTrail(
    {
      mode: "single",
      results: [
        result({
          messages: assistantItems([{ type: "toolCall", name: "grep", args: { pattern: "auth" } }]),
        }),
      ],
    },
    true,
  );

  assert.ok(trail);
  assert.equal(trail.mode, "single");
  assert.equal(trail.live, true);
  assert.equal(trail.mark, "live");
  assert.equal(trail.rows[0].agent, "scout");
  assert.equal(trail.rows[0].mark, "live");
  assert.equal(trail.rows[0].collapsedItems[0].type, "toolCall");
  assert.equal(trail.rows[0].collapsedItems[0].name, "grep");
});

test("final details with 12 items collapse to last 10", () => {
  const items = Array.from({ length: 12 }, (_, i) => ({ type: "text", text: `item-${i + 1}` }));
  const trail = parseSubagentTrail(
    {
      mode: "single",
      results: [
        result({
          messages: assistantItems(items),
        }),
      ],
    },
    false,
  );

  assert.ok(trail);
  assert.equal(trail.live, false);
  assert.equal(trail.mark, "done");
  assert.equal(trail.rows[0].items.length, 12);
  assert.equal(trail.rows[0].collapsedItems.length, 10);
  assert.equal(trail.rows[0].collapsedItems[0].text, "item-3");
  assert.equal(trail.rows[0].collapsedItems.at(-1).text, "item-12");
  assert.equal(trail.rows[0].finalText, "item-12");
});

test("foreign patch details return null", () => {
  assert.equal(parseSubagentTrail({ patch: "diff --git a b" }, false), null);
});

test("parallel live honors exitCode -1", () => {
  const trail = parseSubagentTrail(
    {
      mode: "parallel",
      results: [
        result({ agent: "scout", exitCode: -1, messages: assistantItems([{ type: "toolCall", name: "read" }]) }),
        result({ agent: "planner", exitCode: 0, messages: assistantItems([{ type: "text", text: "plan ready" }]) }),
      ],
    },
    true,
  );

  assert.ok(trail);
  assert.equal(trail.header, "1/2 done, 1 running");
  assert.equal(trail.mark, "live");
  assert.equal(trail.rows[0].mark, "live");
  assert.equal(trail.rows[1].mark, "done");
});

test("valid mode with empty results still parses", () => {
  const trail = parseSubagentTrail({ mode: "chain", results: [] }, true);
  assert.ok(trail);
  assert.equal(trail.mode, "chain");
  assert.deepEqual(trail.rows, []);
});
