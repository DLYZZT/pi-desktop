import assert from "node:assert/strict";
import test from "node:test";
import {
  MAX_REPLAY_RESPONSE_BYTES,
  readBoundedResponseBody,
  runBoundedNetworkAction,
} from "./browser-response-body.ts";

const { AbortController, ReadableStream, Response } = globalThis;

test("rejects an oversized Content-Length before reading the body", async () => {
  let cancelled = false;
  const body = new ReadableStream({
    pull(controller) {
      controller.enqueue(new Uint8Array([1]));
    },
    cancel() {
      cancelled = true;
    },
  });
  const response = new Response(body, { headers: { "content-length": String(MAX_REPLAY_RESPONSE_BYTES + 1) } });

  await assert.rejects(readBoundedResponseBody(response, MAX_REPLAY_RESPONSE_BYTES, new AbortController().signal), {
    code: "RESULT_TOO_LARGE",
  });
  assert.equal(cancelled, true);
});

test("counts streamed bytes when Content-Length is missing or misleading", async () => {
  let cancelled = false;
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array([1, 2, 3]));
      controller.enqueue(new Uint8Array([4, 5, 6]));
    },
    cancel() {
      cancelled = true;
    },
  });
  const response = new Response(body, { headers: { "content-length": "4" } });

  await assert.rejects(readBoundedResponseBody(response, 5, new AbortController().signal), {
    code: "RESULT_TOO_LARGE",
  });
  assert.equal(cancelled, true);
});

test("returns a bounded streamed body without changing its bytes", async () => {
  const expected = Buffer.from("streamed response");
  const response = new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(expected.subarray(0, 5));
        controller.enqueue(expected.subarray(5));
        controller.close();
      },
    }),
  );

  assert.deepEqual(await readBoundedResponseBody(response, 1_024, new AbortController().signal), expected);
});

test("aborts a stalled response at the timeout and settles the task", async () => {
  let observedAbort = false;
  await assert.rejects(
    runBoundedNetworkAction(new AbortController().signal, 5, async (signal) => {
      signal.addEventListener("abort", () => (observedAbort = true), { once: true });
      return new Promise(() => undefined);
    }),
    { code: "ACTION_TIMEOUT" },
  );
  assert.equal(observedAbort, true);
});

test("propagates parent cancellation into a running response task", async () => {
  const parent = new AbortController();
  const task = runBoundedNetworkAction(parent.signal, 10_000, async (signal) => {
    await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
    throw new Error("aborted");
  });

  parent.abort();
  await assert.rejects(task, { code: "USER_TOOK_CONTROL" });
});
