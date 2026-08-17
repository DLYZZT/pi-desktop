import assert from "node:assert/strict";
import test from "node:test";

import {
  applyToolExecutionUpdate,
  clearAllToolExecutionPartials,
  clearToolExecutionPartial,
} from "./tool-execution-partials.ts";

test("second update same id keeps latest content and details", () => {
  const first = applyToolExecutionUpdate(new Map(), {
    toolCallId: "call-1",
    toolName: "subagent",
    partialResult: { content: [{ type: "text", text: "old" }], details: { mode: "single", results: [] } },
  });
  const second = applyToolExecutionUpdate(first, {
    toolCallId: "call-1",
    toolName: "subagent",
    partialResult: {
      content: [{ type: "text", text: "new" }],
      details: { mode: "single", results: [{ agent: "scout" }] },
    },
  });

  assert.equal(second.size, 1);
  const result = second.get("call-1");
  assert.equal(result.content[0].text, "new");
  assert.equal(result.details.results[0].agent, "scout");
});

test("end removes that id", () => {
  const filled = applyToolExecutionUpdate(new Map(), {
    toolCallId: "call-1",
    toolName: "subagent",
    partialResult: { content: [{ type: "text", text: "x" }] },
  });
  const cleared = clearToolExecutionPartial(filled, "call-1");
  assert.equal(cleared.size, 0);
});

test("update without toolCallId leaves the map unchanged", () => {
  const current = applyToolExecutionUpdate(new Map(), {
    toolCallId: "keep",
    partialResult: { content: [{ type: "text", text: "x" }] },
  });
  const next = applyToolExecutionUpdate(current, { partialResult: { content: [{ type: "text", text: "y" }] } });
  assert.equal(next.size, 1);
  assert.equal(next.get("keep").content[0].text, "x");
});

test("content-only partial is still stored", () => {
  const next = applyToolExecutionUpdate(new Map(), {
    toolCallId: "bash-1",
    toolName: "bash",
    partialResult: { content: [{ type: "text", text: "hello" }] },
  });
  const result = next.get("bash-1");
  assert.equal(result.toolName, "bash");
  assert.equal(result.content[0].text, "hello");
  assert.equal(result.details, undefined);
});

test("run reset empties the map", () => {
  const filled = applyToolExecutionUpdate(new Map(), {
    toolCallId: "call-1",
    partialResult: { content: [{ type: "text", text: "x" }] },
  });
  assert.equal(clearAllToolExecutionPartials().size, 0);
  assert.equal(filled.size, 1);
});
