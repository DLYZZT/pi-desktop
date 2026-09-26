import assert from "node:assert/strict";
import test from "node:test";
import { createDeferred } from "#test-timing";
import {
  executeBrowserJavaScript,
  sendBrowserCdpCommand,
  validateBrowserCdpParams,
  validateBrowserJavaScriptSource,
} from "./browser-script-execution.ts";

function harness(respond) {
  const calls = [];
  const state = { destroyed: false, attached: true, released: 0 };
  const target = { tabId: "tab", contents: { isDestroyed: () => state.destroyed }, timeoutMs: () => 50 };
  const cdp = {
    acquire(tabId, reason) {
      assert.equal(tabId, "tab");
      calls.push({ method: "acquire", reason });
      return () => {
        state.released++;
        calls.push({ method: "release" });
      };
    },
    isAttached: () => state.attached,
    async sendCommand(tabId, method, params) {
      assert.equal(tabId, "tab");
      calls.push({ method, params });
      return respond(method, params);
    },
  };
  return { target, cdp, calls, state };
}

test("isolated execution uses the selected context and releases remote handles before its debugger lease", async () => {
  const h = harness((method) => {
    if (method === "Page.getFrameTree") return { frameTree: { frame: { id: "main" } } };
    if (method === "Page.createIsolatedWorld") return { executionContextId: 7 };
    if (method === "Runtime.evaluate") return { result: { objectId: "remote", type: "object", description: "Object" } };
  });
  const result = await executeBrowserJavaScript(
    h.target,
    h.cdp,
    "({answer: 42})",
    { world: "isolated", returnByValue: false, awaitPromise: false },
    new globalThis.AbortController().signal,
  );
  assert.deepEqual(result, {
    value: { type: "object", description: "Object" },
    untrustedWebContent: true,
  });
  const world = h.calls.find(({ method }) => method === "Page.createIsolatedWorld");
  assert.equal(world.params.grantUniveralAccess, false);
  const evaluation = h.calls.find(({ method }) => method === "Runtime.evaluate");
  assert.equal(evaluation.params.contextId, 7);
  assert.equal(evaluation.params.returnByValue, false);
  assert.equal(evaluation.params.awaitPromise, false);
  assert.deepEqual(h.calls.slice(-2), [
    { method: "Runtime.releaseObject", params: { objectId: "remote" } },
    { method: "release" },
  ]);
  assert.equal(h.state.released, 1);
});

test("deadline cancellation terminates evaluation, releases its lease, and consumes a late transport failure", async (t) => {
  const timers = new Map();
  let sequence = 0;
  t.mock.method(globalThis, "setTimeout", (callback, delay) => {
    const id = ++sequence;
    timers.set(id, { callback, delay });
    return id;
  });
  t.mock.method(globalThis, "clearTimeout", (id) => timers.delete(id));
  const pending = createDeferred();
  const h = harness((method) => (method === "Runtime.evaluate" ? pending.promise : undefined));
  const running = executeBrowserJavaScript(h.target, h.cdp, "slow()", {}, new globalThis.AbortController().signal);
  const rejected = assert.rejects(running, (error) => error.code === "JAVASCRIPT_TIMEOUT" && error.retryable);
  [...timers.values()].find(({ delay }) => delay === 50).callback();
  await rejected;
  pending.reject(new Error("late transport failure"));
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(
    h.calls.slice(-2).map(({ method }) => method),
    ["Runtime.terminateExecution", "release"],
  );
  assert.equal(h.state.released, 1);
  assert.equal(timers.size, 0);
});

test("an aborted action releases its debugger lease without sending cleanup into a destroyed renderer", async () => {
  const pending = createDeferred();
  const h = harness((method) => (method === "Runtime.evaluate" ? pending.promise : undefined));
  const controller = new globalThis.AbortController();
  const running = executeBrowserJavaScript(h.target, h.cdp, "slow()", {}, controller.signal);
  const rejected = assert.rejects(running, (error) => error.code === "USER_TOOK_CONTROL");
  h.state.destroyed = true;
  controller.abort();
  await rejected;
  pending.resolve({ result: { value: 1 } });
  assert.equal(h.state.released, 1);
  assert.deepEqual(
    h.calls.map(({ method }) => method),
    ["acquire", "Runtime.evaluate", "release"],
  );
});

test("JavaScript failures redact error details and release handles even when object cleanup rejects", async () => {
  const h = harness((method) => {
    if (method === "Runtime.evaluate")
      return {
        result: { objectId: "remote" },
        exceptionDetails: { exception: { description: "Failure at https://user:secret@example.test/?token=secret" } },
      };
    if (method === "Runtime.releaseObject") throw new Error("already released");
  });
  await assert.rejects(
    executeBrowserJavaScript(h.target, h.cdp, "fail()", {}, new globalThis.AbortController().signal),
    (error) => {
      assert.equal(error.code, "JAVASCRIPT_EXECUTION_FAILED");
      assert.doesNotMatch(error.message + JSON.stringify(error.details), /secret/);
      return true;
    },
  );
  assert.equal(h.state.released, 1);
  assert.ok(h.calls.some(({ method }) => method === "Runtime.releaseObject"));
});

test("raw CDP results release duplicate nested handles once and omit usable remote identifiers", async () => {
  const h = harness((method) => {
    if (method === "Runtime.getProperties")
      return {
        result: [{ value: { objectId: "a" } }, { value: { objectId: "a" } }],
        internalProperties: [{ value: { objectId: "b" } }],
      };
  });
  const result = await sendBrowserCdpCommand(h.cdp, "tab", "Runtime.getProperties", { objectId: "parent" });
  assert.deepEqual(
    h.calls.filter(({ method }) => method === "Runtime.releaseObject").map(({ params }) => params.objectId),
    ["a", "b"],
  );
  assert.equal(result.result[0].value.objectId, "<released>");
  assert.equal(result.internalProperties[0].value.objectId, "<released>");
  assert.equal(h.calls[0].reason, "raw-cdp");
  assert.equal(h.state.released, 1);
});

test("script and CDP byte budgets reject oversize values and still release result handles", async () => {
  assert.throws(
    () => validateBrowserJavaScriptSource("字".repeat(90_000)),
    (error) => error.code === "INVALID_BROWSER_REQUEST",
  );
  assert.throws(
    () => validateBrowserCdpParams({ text: "字".repeat(90_000) }),
    (error) => error.code === "RESULT_TOO_LARGE",
  );
  const huge = "x".repeat(2 * 1024 * 1024);
  const js = harness((method) =>
    method === "Runtime.evaluate" ? { result: { objectId: "large", value: huge } } : undefined,
  );
  await assert.rejects(
    executeBrowserJavaScript(js.target, js.cdp, "large()", {}, new globalThis.AbortController().signal),
    (error) => error.code === "RESULT_TOO_LARGE",
  );
  assert.equal(js.state.released, 1);
  assert.ok(js.calls.some(({ method, params }) => method === "Runtime.releaseObject" && params.objectId === "large"));
  const raw = harness((method) => (method === "Runtime.evaluate" ? { objectId: "large", text: huge } : undefined));
  await assert.rejects(
    sendBrowserCdpCommand(raw.cdp, "tab", "Runtime.evaluate"),
    (error) => error.code === "RESULT_TOO_LARGE",
  );
  assert.equal(raw.state.released, 1);
  assert.ok(raw.calls.some(({ method, params }) => method === "Runtime.releaseObject" && params.objectId === "large"));
});
