/* global AbortController, ReadableStream, Request, Response, TextEncoder -- Node 22 supplies these Web APIs. */

import assert from "node:assert/strict";
import test from "node:test";
import { installFetchBodyAbort } from "./fetch-abort.ts";

test("installFetchBodyAbort cancels the response body when the signal aborts", async () => {
  const original = globalThis.fetch;
  let cancelled = 0;
  const controller = new AbortController();
  globalThis.fetch = async () =>
    new Response(
      new ReadableStream({
        start(streamController) {
          streamController.enqueue(new TextEncoder().encode("chunk"));
        },
        cancel() {
          cancelled += 1;
        },
      }),
    );
  const restore = installFetchBodyAbort(globalThis.fetch);
  try {
    const response = await globalThis.fetch("https://example.test", { signal: controller.signal });
    assert.ok(response.body);
    controller.abort();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(cancelled, 1);
  } finally {
    restore();
    globalThis.fetch = original;
  }
});

test("installFetchBodyAbort reads the signal from a Request", async () => {
  const original = globalThis.fetch;
  let cancelled = 0;
  const controller = new AbortController();
  globalThis.fetch = async () =>
    new Response(
      new ReadableStream({
        cancel() {
          cancelled += 1;
        },
      }),
    );
  const restore = installFetchBodyAbort(globalThis.fetch);
  try {
    await globalThis.fetch(new Request("https://example.test", { signal: controller.signal }));
    controller.abort();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(cancelled, 1);
  } finally {
    restore();
    globalThis.fetch = original;
  }
});
