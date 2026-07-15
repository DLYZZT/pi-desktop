import assert from "node:assert/strict";
import test from "node:test";

import * as Lark from "@larksuiteoapi/node-sdk";
import {
  addFeishuReaction,
  connectFeishuWebSocket,
  getFeishuBotIdentity,
  removeFeishuReaction,
  sendFeishuCard,
  sendFeishuText,
  startFeishuRichCard,
} from "./api.ts";

function fakeHttp(handler) {
  const request = async (options) => handler(options);
  const method =
    (name) =>
    async (url, data, options = {}) =>
      request({ ...options, method: name, url, data });
  return {
    request,
    get: method("get"),
    delete: method("delete"),
    head: method("head"),
    options: method("options"),
    post: method("post"),
    put: method("put"),
    patch: method("patch"),
  };
}

function successfulHttp(calls, response) {
  return fakeHttp(async (options) => {
    calls.push(options);
    if (String(options.url).includes("tenant_access_token")) {
      return { code: 0, tenant_access_token: "tenant-token", expire: 7_200 };
    }
    return response;
  });
}

function credentials(overrides = {}) {
  return {
    appId: "cli_1234567890abcdef",
    appSecret: "fixture-app-secret",
    domain: "feishu",
    ...overrides,
  };
}

test("bot identity probe uses the selected Feishu/Lark domain through the official SDK client", async () => {
  const calls = [];
  const identity = await getFeishuBotIdentity(
    credentials({ appId: "cli_1234567890abcde1", domain: "lark" }),
    successfulHttp(calls, { code: 0, bot: { open_id: "ou_bot", app_name: "Pi Lark Bot" } }),
  );

  assert.deepEqual(identity, { openId: "ou_bot", name: "Pi Lark Bot" });
  assert.ok(calls.some((call) => call.url === "https://open.larksuite.com/open-apis/bot/v3/info"));
  assert.ok(calls.every((call) => String(call.url).startsWith("https://open.larksuite.com/")));
});

test("message create/reply requests preserve receive ID, content, source message, and thread", async () => {
  const createCalls = [];
  const createId = await sendFeishuText(
    credentials({ appId: "cli_1234567890abcde2" }),
    { peerId: "oc_group", text: "hello" },
    successfulHttp(createCalls, { code: 0, data: { message_id: "om_created" } }),
  );
  assert.equal(createId, "om_created");
  const create = createCalls.find((call) => String(call.url).endsWith("/open-apis/im/v1/messages"));
  assert.deepEqual(create.params, { receive_id_type: "chat_id" });
  assert.deepEqual(create.data, { receive_id: "oc_group", content: '{"text":"hello"}', msg_type: "text" });

  const replyCalls = [];
  const replyId = await sendFeishuText(
    credentials({ appId: "cli_1234567890abcde3", domain: "lark" }),
    { peerId: "oc_group", text: "thread reply", replyToMessageId: "om_source", replyInThread: true },
    successfulHttp(replyCalls, { code: 0, data: { message_id: "om_reply" } }),
  );
  assert.equal(replyId, "om_reply");
  const reply = replyCalls.find((call) => String(call.url).endsWith("/open-apis/im/v1/messages/om_source/reply"));
  assert.deepEqual(reply.data, {
    content: '{"text":"thread reply"}',
    msg_type: "text",
    reply_in_thread: true,
  });
});

test("SDK errors never expose the App Secret", async () => {
  const secret = "fixture-sensitive-app-secret";
  const http = fakeHttp(async () => {
    throw new Error(`provider echoed ${secret}`);
  });
  await assert.rejects(
    getFeishuBotIdentity(credentials({ appId: "cli_1234567890abcde4", appSecret: secret }), http),
    (error) => {
      assert.doesNotMatch(error.message, new RegExp(secret));
      assert.match(error.message, /\[REDACTED\]/);
      return true;
    },
  );
});

test("inline Markdown cards preserve reply and thread routing through the official SDK", async () => {
  const calls = [];
  const messageId = await sendFeishuCard(
    credentials({ appId: "cli_1234567890abcde5" }),
    {
      peerId: "oc_group",
      replyToMessageId: "om_source",
      replyInThread: true,
      card: { schema: "2.0", body: { elements: [{ tag: "markdown", content: "**hello**" }] } },
    },
    successfulHttp(calls, { code: 0, data: { message_id: "om_card" } }),
  );

  assert.equal(messageId, "om_card");
  const reply = calls.find((call) => String(call.url).endsWith("/open-apis/im/v1/messages/om_source/reply"));
  assert.equal(reply.data.msg_type, "interactive");
  assert.equal(reply.data.reply_in_thread, true);
  assert.deepEqual(JSON.parse(reply.data.content), {
    schema: "2.0",
    body: { elements: [{ tag: "markdown", content: "**hello**" }] },
  });
});

test("CardKit session creates, sends, streams, and finalizes one card with monotonic sequences", async () => {
  const calls = [];
  const http = fakeHttp(async (options) => {
    calls.push(options);
    const url = String(options.url);
    if (url.includes("tenant_access_token")) return { code: 0, tenant_access_token: "tenant-token", expire: 7_200 };
    if (url.endsWith("/open-apis/cardkit/v1/cards") && options.method === "POST") {
      return { code: 0, data: { card_id: "card_stream" } };
    }
    if (url.endsWith("/open-apis/im/v1/messages/om_source/reply")) {
      return { code: 0, data: { message_id: "om_stream" } };
    }
    return { code: 0, data: {} };
  });
  const initialCard = {
    schema: "2.0",
    config: { streaming_mode: true },
    body: { elements: [{ tag: "markdown", element_id: "stream_md", content: "正在思考…" }] },
  };
  const session = await startFeishuRichCard(
    credentials({ appId: "cli_1234567890abcde6", domain: "lark" }),
    {
      peerId: "oc_group",
      replyToMessageId: "om_source",
      replyInThread: true,
      card: initialCard,
    },
    http,
  );
  assert.equal(session.cardId, "card_stream");
  assert.equal(session.messageId, "om_stream");

  await session.update("思考中\n\n**answer**");
  const finalCard = {
    schema: "2.0",
    config: { streaming_mode: false },
    body: { elements: [{ tag: "markdown", content: "## answer" }] },
  };
  await session.finish(finalCard);

  const create = calls.find(
    (call) => String(call.url).endsWith("/open-apis/cardkit/v1/cards") && call.method === "POST",
  );
  assert.equal(create.data.type, "card_json");
  assert.deepEqual(JSON.parse(create.data.data), initialCard);

  const send = calls.find((call) => String(call.url).endsWith("/open-apis/im/v1/messages/om_source/reply"));
  assert.equal(send.data.msg_type, "interactive");
  assert.equal(send.data.reply_in_thread, true);
  assert.deepEqual(JSON.parse(send.data.content), { type: "card", data: { card_id: "card_stream" } });

  const update = calls.find((call) => String(call.url).includes("/elements/stream_md/content"));
  assert.equal(update.method, "PUT");
  assert.equal(update.data.content, "思考中\n\n**answer**");
  assert.equal(update.data.sequence, 1);
  assert.equal(typeof update.data.uuid, "string");

  const finish = calls.find(
    (call) => String(call.url).endsWith("/open-apis/cardkit/v1/cards/card_stream") && call.method === "PUT",
  );
  assert.equal(finish.data.sequence, 2);
  assert.deepEqual(JSON.parse(finish.data.card.data), finalCard);
});

test("CardKit finalization patches the same message when full card update is rejected", async () => {
  const calls = [];
  const http = fakeHttp(async (options) => {
    calls.push(options);
    const url = String(options.url);
    if (url.includes("tenant_access_token")) return { code: 0, tenant_access_token: "tenant-token", expire: 7_200 };
    if (url.endsWith("/open-apis/cardkit/v1/cards") && options.method === "POST") {
      return { code: 0, data: { card_id: "card_patch" } };
    }
    if (url.endsWith("/open-apis/im/v1/messages/om_source/reply")) {
      return { code: 0, data: { message_id: "om_patch" } };
    }
    if (url.endsWith("/open-apis/cardkit/v1/cards/card_patch") && options.method === "PUT") {
      return { code: 230099, msg: "card update rejected" };
    }
    return { code: 0, data: {} };
  });
  const session = await startFeishuRichCard(
    credentials({ appId: "cli_1234567890abcde7" }),
    {
      peerId: "ou_user",
      replyToMessageId: "om_source",
      card: {
        schema: "2.0",
        config: { streaming_mode: true },
        body: { elements: [{ tag: "markdown", element_id: "stream_md", content: "start" }] },
      },
    },
    http,
  );
  const finalCard = {
    schema: "2.0",
    config: { streaming_mode: false, update_multi: true },
    body: { elements: [{ tag: "markdown", content: "final" }] },
  };
  await session.finish(finalCard);

  const patch = calls.find(
    (call) => String(call.url).endsWith("/open-apis/im/v1/messages/om_patch") && call.method === "PATCH",
  );
  assert.ok(patch);
  assert.deepEqual(JSON.parse(patch.data.content), finalCard);
});

test("message reactions are added and removed through the official SDK", async () => {
  const calls = [];
  const http = successfulHttp(calls, { code: 0, data: { reaction_id: "reaction-one" } });
  const reactionId = await addFeishuReaction(
    credentials({ appId: "cli_1234567890abcde8" }),
    "om_source",
    "THINKING",
    http,
  );
  assert.equal(reactionId, "reaction-one");
  const create = calls.find((call) => String(call.url).endsWith("/open-apis/im/v1/messages/om_source/reactions"));
  assert.deepEqual(create.data, { reaction_type: { emoji_type: "THINKING" } });

  calls.length = 0;
  await removeFeishuReaction(
    credentials({ appId: "cli_1234567890abcde9" }),
    "om_source",
    "reaction-one",
    successfulHttp(calls, { code: 0, data: {} }),
  );
  assert.ok(
    calls.some(
      (call) =>
        call.method === "DELETE" &&
        String(call.url).endsWith("/open-apis/im/v1/messages/om_source/reactions/reaction-one"),
    ),
  );
});

test("slow initial WebSocket stays alive, reports reconnecting, then reaches ready and closes on demand", async (t) => {
  const originalStart = Lark.WSClient.prototype.start;
  const originalClose = Lark.WSClient.prototype.close;
  let client;
  let dispatcher;
  const closeCalls = [];
  Lark.WSClient.prototype.start = async function (params) {
    client = this;
    dispatcher = params.eventDispatcher;
  };
  Lark.WSClient.prototype.close = function (params) {
    closeCalls.push(params);
    return originalClose.call(this, params);
  };
  t.after(() => {
    Lark.WSClient.prototype.start = originalStart;
    Lark.WSClient.prototype.close = originalClose;
  });

  const events = [];
  const menuEvents = [];
  let reconnecting = 0;
  let reconnected = 0;
  let settled = false;
  const controller = new globalThis.AbortController();
  const pending = connectFeishuWebSocket(
    credentials({ domain: "lark" }),
    { onMessage: (event) => events.push(event), onMenu: (event) => menuEvents.push(event) },
    {
      onError(error) {
        assert.fail(error.message);
      },
      onReconnecting() {
        reconnecting += 1;
      },
      onReconnected() {
        reconnected += 1;
      },
    },
    controller.signal,
    5,
  );
  void pending.then(() => {
    settled = true;
  });

  await new Promise((resolve) => setTimeout(resolve, 15));
  assert.equal(settled, false, "the startup status timer must not terminate the SDK retry loop");
  assert.equal(reconnecting, 1);
  assert.equal(closeCalls.length, 0);
  assert.deepEqual(client.wsConfig.getClient(), {
    appId: "cli_1234567890abcdef",
    appSecret: "fixture-app-secret",
    clientAssertionProvider: undefined,
    domain: "https://open.larksuite.com",
  });
  assert.equal(client.handshakeTimeoutMs, 15_000);
  assert.equal(client.pingTimeoutSec, 10);

  client.onReady();
  const connection = await pending;
  const event = { message: { message_id: "om_event" } };
  dispatcher.handles.get("im.message.receive_v1")(event);
  assert.deepEqual(events, [event]);
  const menuEvent = { event_id: "menu-event", event_key: "pi_status" };
  dispatcher.handles.get("application.bot.menu_v6")(menuEvent);
  assert.deepEqual(menuEvents, [menuEvent]);
  client.onReconnecting();
  client.onReconnected();
  assert.equal(reconnecting, 2);
  assert.equal(reconnected, 1);

  connection.close();
  assert.deepEqual(closeCalls, [{ force: true }]);
});

test("aborting a pending WebSocket startup closes the SDK client without leaking handles", async (t) => {
  const originalStart = Lark.WSClient.prototype.start;
  const originalClose = Lark.WSClient.prototype.close;
  let closeParams;
  Lark.WSClient.prototype.start = async () => undefined;
  Lark.WSClient.prototype.close = function (params) {
    closeParams = params;
    return originalClose.call(this, params);
  };
  t.after(() => {
    Lark.WSClient.prototype.start = originalStart;
    Lark.WSClient.prototype.close = originalClose;
  });

  const controller = new globalThis.AbortController();
  const pending = connectFeishuWebSocket(
    credentials(),
    { onMessage: () => undefined, onMenu: () => undefined },
    {
      onError: () => undefined,
      onReconnecting: () => undefined,
      onReconnected: () => undefined,
    },
    controller.signal,
    1_000,
  );
  controller.abort();
  await assert.rejects(pending, /长连接已停止/);
  assert.deepEqual(closeParams, { force: true });
});
