import { importTestBundle } from "#test-bundle";
import assert from "node:assert/strict";
import test from "node:test";

const { AgentSessionWrapper, abortLiveRpcSession } = await importTestBundle("src/agent-host/rpc-manager", {
  packages: "external",
  stdin: {
    contents: 'export { AgentSessionWrapper, abortLiveRpcSession } from "./rpc-manager.ts";',
    resolveDir: import.meta.dirname,
    sourcefile: "rpc-manager-abort-test-entry.ts",
    loader: "ts",
  },
});

function createFakeInner() {
  const listeners = [];
  let promptCalls = 0;
  let abortCalls = 0;
  let promptGate = Promise.resolve();
  return {
    sessionId: "session-abort",
    sessionFile: "",
    sessionManager: { getHeader: () => ({ cwd: "/tmp" }) },
    agent: {
      state: { messages: [], systemPrompt: "" },
      abort() {
        abortCalls += 1;
      },
    },
    isStreaming: false,
    isCompacting: false,
    promptCalls: () => promptCalls,
    abortCalls: () => abortCalls,
    setPromptGate(promise) {
      promptGate = promise;
    },
    emit(event) {
      for (const listener of listeners) listener(event);
    },
    subscribe(listener) {
      listeners.push(listener);
      return () => {
        const index = listeners.indexOf(listener);
        if (index !== -1) listeners.splice(index, 1);
      };
    },
    async prompt() {
      promptCalls += 1;
      await promptGate;
    },
    async abort() {
      abortCalls += 1;
    },
    steerCalls: 0,
    async steer() {
      this.steerCalls += 1;
    },
    async followUp() {},
  };
}

function createWrapper(inner) {
  const wrapper = new AgentSessionWrapper(inner, []);
  wrapper.extensionsBound = true;
  wrapper.start();
  return wrapper;
}

async function waitFor(predicate, label) {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > 1000) throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolve) => setImmediate(resolve));
  }
}

test("abort during extension bind skips the queued prompt", async () => {
  const inner = createFakeInner();
  const wrapper = createWrapper(inner);
  wrapper.extensionsBound = false;
  let releaseBind;
  wrapper.ensureExtensionsBound = () =>
    new Promise((resolve) => {
      releaseBind = resolve;
    });

  const prompt = wrapper.send({ type: "prompt", message: "hello" });
  await wrapper.send({ type: "abort" });
  releaseBind();
  await prompt;
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(inner.promptCalls(), 0);
  wrapper.destroy();
});

test("abort before agent_start cancels the run when it starts", async () => {
  const inner = createFakeInner();
  let releasePrompt;
  inner.setPromptGate(
    new Promise((resolve) => {
      releasePrompt = resolve;
    }),
  );
  const wrapper = createWrapper(inner);

  const prompt = wrapper.send({ type: "prompt", message: "hello" });
  await prompt;
  await waitFor(() => inner.promptCalls() === 1, "inner.prompt");
  await wrapper.send({ type: "abort" });
  assert.ok(inner.abortCalls() >= 1);

  inner.emit({ type: "agent_start" });
  assert.ok(inner.abortCalls() >= 2);

  releasePrompt();
  inner.emit({ type: "agent_end" });
  await prompt;
  wrapper.destroy();
});

test("abort command returns before waitForIdle settles", async () => {
  const inner = createFakeInner();
  let releaseAbort;
  inner.abort = () =>
    new Promise((resolve) => {
      releaseAbort = resolve;
    });
  const wrapper = createWrapper(inner);
  inner.isStreaming = true;

  const result = await Promise.race([
    wrapper.send({ type: "abort" }).then(() => "returned"),
    new Promise((resolve) => setTimeout(() => resolve("hung"), 50)),
  ]);
  assert.equal(result, "returned");
  assert.equal(wrapper.pendingAbort, true);
  releaseAbort();
  wrapper.destroy();
});

test("a new prompt after abort is not skipped by the abort latch", async () => {
  const inner = createFakeInner();
  inner.isStreaming = true;
  const wrapper = createWrapper(inner);

  await wrapper.send({ type: "prompt", message: "first" });
  await waitFor(() => inner.promptCalls() === 1, "first prompt");
  await wrapper.send({ type: "abort" });
  inner.isStreaming = false;
  await wrapper.send({ type: "prompt", message: "next" });
  await waitFor(() => inner.promptCalls() === 2, "prompt after abort");
  wrapper.destroy();
});

test("idle abort does not latch and cancel the next prompt", async () => {
  const inner = createFakeInner();
  const wrapper = createWrapper(inner);

  await wrapper.send({ type: "abort" });
  await wrapper.send({ type: "prompt", message: "next" });
  await waitFor(() => inner.promptCalls() === 1, "next prompt");
  wrapper.destroy();
});

test("steer still injects after abort latch and cuts the current run", async () => {
  const inner = createFakeInner();
  inner.isStreaming = true;
  const wrapper = createWrapper(inner);
  wrapper.pendingAbort = true;

  await wrapper.send({ type: "steer", message: "go left" });

  assert.equal(inner.steerCalls, 1);
  assert.equal(wrapper.pendingAbort, false);
  assert.ok(inner.abortCalls() >= 1);
  wrapper.destroy();
});

test("abortLiveRpcSession does not start a missing session", () => {
  assert.equal(abortLiveRpcSession("missing-session"), false);
});
