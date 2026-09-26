import assert from "node:assert/strict";
import test from "node:test";
import { createSessionTurnState, readCompactResult, reduceSessionTurnState } from "./session-turn-state.ts";

const event = (state, type, payload = {}) =>
  reduceSessionTurnState(state, { type: "event", event: { type, ...payload } });
const assistant = (content) => ({ role: "assistant", content });

test("a prompt survives intermediate SDK run ends and ignores stream messages after settlement", () => {
  let state = event(createSessionTurnState(), "agent_start");
  const message = assistant([{ type: "text", text: "partial" }]);
  state = event(state, "message_update", { message });
  assert.equal(state.agentRunning, true);
  assert.equal(state.streamState.streamingMessage.content[0].text, "partial");
  assert.equal(event(state, "agent_end"), state);
  assert.equal(event(state, "prompt_done"), state, "the caller must validate and reconcile prompt completion first");
  state = reduceSessionTurnState(state, { type: "settled" });
  assert.equal(state.agentRunning, false);
  assert.equal(state.agentPhase, null);
  assert.deepEqual(state.streamState, { isStreaming: false, streamingMessage: null });
  for (const type of ["message_start", "message_update", "message_end"]) {
    assert.equal(event(state, type, { message }), state);
  }
});

test("stream normalization preserves input messages and excludes user/system previews", () => {
  const initial = event(createSessionTurnState(), "agent_start");
  const message = assistant([{ type: "toolCall", id: "tool-1", name: "read", arguments: { path: "file.ts" } }]);
  const next = event(initial, "message_update", { message });
  assert.deepEqual(next.streamState.streamingMessage.content, [
    { type: "toolCall", toolCallId: "tool-1", toolName: "read", input: { path: "file.ts" } },
  ]);
  assert.equal(message.content[0].id, "tool-1");
  assert.equal(initial.streamState.streamingMessage, null);
  for (const role of ["user", "system"]) {
    assert.equal(event(next, "message_update", { message: { role, content: "hidden" } }), next);
  }
  const ended = event(next, "message_end", { message });
  assert.equal(ended.agentRunning, true);
  assert.deepEqual(ended.agentPhase, { kind: "waiting_model" });
  assert.equal(ended.streamState.streamingMessage, null);
});

test("parallel tool phases deduplicate starts and wait until the last tool finishes", () => {
  let state = event(createSessionTurnState(), "agent_start");
  state = event(state, "tool_execution_start", { toolCallId: "one", toolName: "read" });
  const oneTool = state;
  state = event(state, "tool_execution_start", { toolCallId: "two", toolName: "bash" });
  state = event(state, "tool_execution_start", { toolCallId: "one", toolName: "read" });
  assert.equal(state.agentPhase.tools.length, 2);
  assert.equal(oneTool.agentPhase.tools.length, 1);
  state = event(state, "tool_execution_end", { toolCallId: "one" });
  assert.deepEqual(state.agentPhase, { kind: "running_tools", tools: [{ id: "two", name: "bash" }] });
  state = event(state, "tool_execution_end", { toolCallId: "two" });
  assert.deepEqual(state.agentPhase, { kind: "waiting_model" });
});

test("retry state ends independently of the enclosing prompt", () => {
  let state = reduceSessionTurnState(createSessionTurnState(), { type: "start", phase: "running_command" });
  assert.deepEqual(state.agentPhase, { kind: "running_command" });
  state = event(state, "auto_retry_start", { attempt: 1, maxAttempts: 3, errorMessage: "temporary failure" });
  assert.deepEqual(state.retryInfo, { attempt: 1, maxAttempts: 3, errorMessage: "temporary failure" });
  state = event(state, "auto_retry_end");
  assert.equal(state.agentRunning, true);
  assert.equal(state.retryInfo, null);
  state = event(state, "auto_retry_start", { attempt: 2, maxAttempts: 3 });
  assert.equal(reduceSessionTurnState(state, { type: "settled" }).retryInfo, null);
});

test("queue snapshots are independent of transport arrays and other sessions", () => {
  const other = createSessionTurnState();
  const steering = ["steer"];
  const followUp = ["follow up"];
  let state = event(createSessionTurnState(), "queue_update", { steering, followUp });
  steering.push("late mutation");
  followUp.length = 0;
  assert.deepEqual(state.queuedMessages, { steering: ["steer"], followUp: ["follow up"] });
  assert.deepEqual(other.queuedMessages, { steering: [], followUp: [] });
  state = reduceSessionTurnState(state, { type: "queue-snapshot", queuedMessages: { steering: [], followUp: [] } });
  assert.deepEqual(state.queuedMessages, { steering: [], followUp: [] });
});

test("compaction success, failure and abort settle without finishing the prompt", () => {
  let state = event(event(createSessionTurnState(), "agent_start"), "auto_compaction_start");
  assert.equal(state.isCompacting, true);
  state = event(state, "auto_compaction_end", {
    reason: "threshold",
    result: { tokensBefore: 100, estimatedTokensAfter: 20 },
  });
  assert.deepEqual(state.compactResult, { reason: "threshold", tokensBefore: 100, estimatedTokensAfter: 20 });
  assert.equal(state.isCompacting, false);
  assert.equal(state.agentRunning, true);
  state = event(state, "compaction_start");
  assert.equal(state.compactResult, null);
  state = event(state, "compaction_end", { errorMessage: "failed" });
  assert.equal(state.compactError, "failed");
  assert.equal(state.compactResult, null);
  state = event(state, "compaction_start");
  state = event(state, "compaction_end", { aborted: true, result: { tokensBefore: 100, estimatedTokensAfter: 10 } });
  assert.equal(state.isCompacting, false);
  assert.equal(state.compactResult, null);
  assert.equal(state.compactError, null);
});

test("manual compaction retains its result while the caller finishes reloading history", () => {
  let state = reduceSessionTurnState(createSessionTurnState(), { type: "compaction-start" });
  state = reduceSessionTurnState(state, {
    type: "compaction-result",
    result: readCompactResult({ tokensBefore: 80, estimatedTokensAfter: 12 }, "manual"),
  });
  assert.equal(state.isCompacting, true);
  state = reduceSessionTurnState(state, { type: "compaction-state", isCompacting: false });
  assert.equal(state.compactResult.estimatedTokensAfter, 12);
  state = reduceSessionTurnState(state, { type: "compaction-result", result: null });
  assert.equal(state.compactResult, null);
  assert.equal(readCompactResult({ tokensBefore: 80 }, "manual"), null);
});

test("send failure clears transient streaming and unrelated events preserve state", () => {
  let state = event(createSessionTurnState(), "agent_start");
  state = event(state, "message_update", { message: assistant([{ type: "text", text: "draft" }]) });
  state = reduceSessionTurnState(state, { type: "send-failed" });
  assert.equal(state.agentRunning, false);
  assert.equal(state.streamState.isStreaming, false);
  assert.equal(state.agentPhase, null);
  assert.equal(event(state, "extension_ui_request", { method: "setTitle", title: "Example" }), state);
});
