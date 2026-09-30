import assert from "node:assert/strict";
import test from "node:test";
import { importTestBundle } from "#test-bundle";
import path from "node:path";
const { projectChannelToolProgress } = await importTestBundle("channel-tool-progress", {
  packages: "external",
  entryPoints: [path.join(import.meta.dirname, "tool-progress.ts")],
});

test("IM progress keeps parent cards and never forwards independent child payloads", () => {
  for (const type of ["tool_execution_start", "tool_execution_update", "tool_execution_end"]) {
    const child = {
      type,
      toolCallId: "child",
      parentToolCallId: "parent",
      toolName: "nested_tool",
      args: { text: "RAW_CHILD_ARGUMENT" },
      result: { text: "RAW_CHILD_RESULT" },
    };
    assert.equal(projectChannelToolProgress(child), undefined);
    const parent = projectChannelToolProgress({
      ...child,
      toolCallId: "parent",
      parentToolCallId: undefined,
      isError: true,
    });
    assert.equal(parent.toolCallId, "parent");
    if (type === "tool_execution_end") assert.equal(parent.isError, true);
  }
});
