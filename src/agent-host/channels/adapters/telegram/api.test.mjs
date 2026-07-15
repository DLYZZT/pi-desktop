import assert from "node:assert/strict";
import test from "node:test";

import {
  escapeTelegramHtml,
  getTelegramBot,
  getTelegramUpdates,
  deleteTelegramCommands,
  sendTelegramMessage,
  sendTelegramMessageDraft,
  sendTelegramRichMessage,
  sendTelegramRichMessageDraft,
  setTelegramMessageReaction,
  setTelegramCommands,
  TelegramApiError,
} from "./api.ts";

function jsonResponse(value, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? "OK" : "Error",
    json: async () => value,
  };
}

test("getMe verifies the BotFather token without exposing it in a request body", async (t) => {
  const original = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = original;
  });
  let request;
  globalThis.fetch = async (url, init) => {
    request = { url: String(url), init };
    return jsonResponse({ ok: true, result: { id: 42, is_bot: true, first_name: "Pi", username: "pi_bot" } });
  };
  const bot = await getTelegramBot({ baseUrl: "https://telegram.example", token: "42:test-token" });
  assert.equal(bot.username, "pi_bot");
  assert.match(request.url, /\/bot42:test-token\/getMe$/);
  assert.deepEqual(JSON.parse(request.init.body), {});
});

test("getUpdates sends the confirmed offset, long-poll timeout, and message filter", async (t) => {
  const original = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = original;
  });
  let body;
  globalThis.fetch = async (_url, init) => {
    body = JSON.parse(init.body);
    return jsonResponse({ ok: true, result: [] });
  };
  await getTelegramUpdates({
    baseUrl: "https://telegram.example",
    token: "token",
    offset: 101,
    timeoutSeconds: 30,
    signal: new globalThis.AbortController().signal,
  });
  assert.deepEqual(body, { offset: 101, limit: 100, timeout: 30, allowed_updates: ["message"] });
});

test("sendMessage uses safe HTML, topic routing, and modern reply parameters", async (t) => {
  const original = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = original;
  });
  let body;
  globalThis.fetch = async (_url, init) => {
    body = JSON.parse(init.body);
    return jsonResponse({
      ok: true,
      result: { message_id: 88, date: 1, chat: { id: -100, type: "supergroup" } },
    });
  };
  await sendTelegramMessage({
    baseUrl: "https://telegram.example",
    token: "token",
    chatId: "-100",
    html: escapeTelegramHtml("<hello> & goodbye"),
    threadId: "7",
    replyToMessageId: "55",
  });
  assert.equal(body.text, "&lt;hello&gt; &amp; goodbye");
  assert.equal(body.parse_mode, "HTML");
  assert.equal(body.message_thread_id, 7);
  assert.deepEqual(body.reply_parameters, { message_id: 55, allow_sending_without_reply: true });
});

test("Rich Message APIs preserve draft identity, topic routing, and replies", async (t) => {
  const original = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = original;
  });
  const requests = [];
  globalThis.fetch = async (url, init) => {
    const endpoint = String(url).split("/").at(-1);
    requests.push({ endpoint, body: JSON.parse(init.body) });
    return endpoint === "sendRichMessage"
      ? jsonResponse({ ok: true, result: { message_id: 91, date: 1, chat: { id: 7, type: "private" } } })
      : jsonResponse({ ok: true, result: true });
  };

  await sendTelegramRichMessageDraft({
    baseUrl: "https://telegram.example",
    token: "token",
    chatId: "7",
    draftId: 123,
    markdown: "<tg-thinking>思考中</tg-thinking>",
    threadId: "9",
  });
  await sendTelegramMessageDraft({
    baseUrl: "https://telegram.example",
    token: "token",
    chatId: "7",
    draftId: 123,
    text: "思考中",
    threadId: "9",
  });
  await sendTelegramRichMessage({
    baseUrl: "https://telegram.example",
    token: "token",
    chatId: "7",
    markdown: "## 完成",
    threadId: "9",
    replyToMessageId: "55",
  });

  assert.deepEqual(requests[0], {
    endpoint: "sendRichMessageDraft",
    body: {
      chat_id: 7,
      draft_id: 123,
      rich_message: { markdown: "<tg-thinking>思考中</tg-thinking>", skip_entity_detection: true },
      message_thread_id: 9,
    },
  });
  assert.deepEqual(requests[1], {
    endpoint: "sendMessageDraft",
    body: { chat_id: 7, draft_id: 123, text: "思考中", message_thread_id: 9 },
  });
  assert.deepEqual(requests[2], {
    endpoint: "sendRichMessage",
    body: {
      chat_id: "7",
      rich_message: { markdown: "## 完成", skip_entity_detection: true },
      message_thread_id: 9,
      reply_parameters: { message_id: 55, allow_sending_without_reply: true },
    },
  });
});

test("Telegram command menu can be installed and removed", async (t) => {
  const original = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = original;
  });
  const requests = [];
  globalThis.fetch = async (url, init) => {
    requests.push({ url: String(url), body: JSON.parse(init.body) });
    return jsonResponse({ ok: true, result: true });
  };
  const commands = [{ command: "help", description: "显示可用命令" }];
  await setTelegramCommands({ baseUrl: "https://telegram.example", token: "token", commands });
  await deleteTelegramCommands({ baseUrl: "https://telegram.example", token: "token" });
  assert.match(requests[0].url, /\/setMyCommands$/);
  assert.deepEqual(requests[0].body, { commands });
  assert.match(requests[1].url, /\/deleteMyCommands$/);
  assert.deepEqual(requests[1].body, {});
});

test("Telegram message reaction replaces the bot status on the source message", async (t) => {
  const original = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = original;
  });
  let request;
  globalThis.fetch = async (url, init) => {
    request = { url: String(url), body: JSON.parse(init.body) };
    return jsonResponse({ ok: true, result: true });
  };
  await setTelegramMessageReaction({
    baseUrl: "https://telegram.example",
    token: "token",
    chatId: "-1001",
    messageId: "55",
    emoji: "👀",
  });
  assert.match(request.url, /\/setMessageReaction$/);
  assert.deepEqual(request.body, {
    chat_id: "-1001",
    message_id: 55,
    reaction: [{ type: "emoji", emoji: "👀" }],
  });
});

test("Telegram API errors preserve 409 and 429 classification metadata", async (t) => {
  const original = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = original;
  });
  globalThis.fetch = async () =>
    jsonResponse({ ok: false, error_code: 429, description: "Too Many Requests", parameters: { retry_after: 3 } }, 429);
  await assert.rejects(
    getTelegramBot({ token: "token" }),
    (error) => error instanceof TelegramApiError && error.errorCode === 429 && error.retryAfter === 3,
  );
});
