import assert from "node:assert/strict";
import test from "node:test";

import { bodyFromWeixinMessage, getUpdates, sendText, startQrLogin } from "./api.ts";

function jsonResponse(value) {
  return {
    ok: true,
    status: 200,
    text: async () => JSON.stringify(value),
  };
}

test("starts QR login with Tencent iLink headers and no credential", async (t) => {
  const original = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = original;
  });
  let request;
  globalThis.fetch = async (url, init) => {
    request = { url: String(url), init };
    return jsonResponse({ qrcode: "opaque", qrcode_img_content: "https://weixin.qq.com/x/test" });
  };
  const result = await startQrLogin(["local-one", "local-two"]);
  assert.equal(result.qrcode, "opaque");
  assert.match(request.url, /get_bot_qrcode\?bot_type=3/);
  assert.equal(request.init.headers["iLink-App-Id"], "bot");
  assert.equal(request.init.headers.AuthorizationType, "ilink_bot_token");
  assert.equal("Authorization" in request.init.headers, false);
  assert.deepEqual(JSON.parse(request.init.body).local_token_list, ["local-one", "local-two"]);
});

test("getUpdates sends cursor and preserves it on an aborted long poll", async (t) => {
  const original = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = original;
  });
  let body;
  globalThis.fetch = async (_url, init) => {
    body = JSON.parse(init.body);
    return jsonResponse({ ret: 0, msgs: [], get_updates_buf: "cursor-next" });
  };
  const response = await getUpdates({
    baseUrl: "https://example.test",
    token: "secret-token",
    cursor: "cursor-old",
    timeoutMs: 100,
    signal: new globalThis.AbortController().signal,
  });
  assert.equal(body.get_updates_buf, "cursor-old");
  assert.equal(body.base_info.bot_agent, "PiDesktop/0.1.0");
  assert.equal(response.get_updates_buf, "cursor-next");
});

test("sendText includes provider context token and a stable client id", async (t) => {
  const original = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = original;
  });
  let request;
  globalThis.fetch = async (_url, init) => {
    request = { headers: init.headers, body: JSON.parse(init.body) };
    return jsonResponse({ ret: 0 });
  };
  await sendText({
    baseUrl: "https://example.test",
    token: "secret-token",
    to: "user-one",
    text: "hello",
    contextToken: "context-one",
    clientId: "client-one",
  });
  assert.equal(request.headers.Authorization, "Bearer secret-token");
  assert.equal(request.body.msg.context_token, "context-one");
  assert.equal(request.body.msg.client_id, "client-one");
  assert.equal(request.body.msg.item_list[0].text_item.text, "hello");
});

test("normalizes text, transcribed voice, and unsupported attachment metadata", () => {
  assert.deepEqual(
    bodyFromWeixinMessage({
      item_list: [
        { type: 1, text_item: { text: "hello" } },
        { type: 2 },
        { type: 4, file_item: { file_name: "notes.txt" } },
      ],
    }),
    { text: "hello", attachments: [{ kind: "image" }, { kind: "file", name: "notes.txt" }] },
  );
  assert.equal(
    bodyFromWeixinMessage({ item_list: [{ type: 3, voice_item: { text: "voice text" } }] }).text,
    "voice text",
  );
});
