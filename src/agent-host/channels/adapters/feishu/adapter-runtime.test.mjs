import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";

const output = path.join(
  import.meta.dirname,
  "../../../../../.artifacts/test-modules",
  `feishu-adapter-runtime-${process.pid}.mjs`,
);
mkdirSync(path.dirname(output), { recursive: true });
await build({
  stdin: {
    contents: [
      'export { FeishuAdapter, normalizeFeishuEvent, normalizeFeishuMenuEvent } from "./adapter.ts";',
      'export { FeishuApiError } from "./api.ts";',
      'export { ChannelStateStore } from "../../state-store.ts";',
    ].join("\n"),
    resolveDir: import.meta.dirname,
    sourcefile: "feishu-adapter-runtime-test-entry.ts",
    loader: "ts",
  },
  outfile: output,
  bundle: true,
  format: "esm",
  platform: "node",
  packages: "external",
  logLevel: "silent",
});

const { ChannelStateStore, FeishuAdapter, FeishuApiError, normalizeFeishuEvent, normalizeFeishuMenuEvent } =
  await import(`${pathToFileURL(output).href}?v=${Date.now()}`);

function account(overrides = {}) {
  const now = new Date().toISOString();
  return {
    id: "feishu-runtime",
    channel: "feishu",
    name: "Pi Feishu Bot",
    enabled: true,
    providerAccountId: "ou_bot",
    appId: "cli_1234567890abcdef",
    domain: "feishu",
    baseUrl: "https://open.feishu.cn",
    dmPolicy: "open",
    allowFrom: [],
    groupPolicy: "disabled",
    groupIds: [],
    groupAllowFrom: [],
    requireMention: true,
    toolNames: [],
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function messageEvent(overrides = {}) {
  return {
    event_id: "event-one",
    sender: {
      sender_id: { open_id: "ou_user" },
      sender_type: "user",
    },
    message: {
      message_id: "om_message_one",
      create_time: "1700000000000",
      chat_id: "oc_group",
      chat_type: "group",
      message_type: "text",
      content: JSON.stringify({ text: "@_user_1 please review" }),
      mentions: [{ key: "@_user_1", id: { open_id: "ou_bot" }, name: "Pi Bot" }],
      thread_id: "omt_thread",
    },
    ...overrides,
  };
}

function stateStore() {
  const dir = mkdtempSync(path.join(tmpdir(), "pi-feishu-runtime-"));
  return new ChannelStateStore(path.join(dir, "state.json"));
}

function dependencies(overrides = {}) {
  return {
    async getBotIdentity() {
      return { openId: "ou_bot", name: "Pi Bot" };
    },
    async sendText() {
      return "om_sent";
    },
    async sendCard() {
      return "om_card";
    },
    async downloadResource() {
      return { kind: "file", data: Buffer.from("fixture") };
    },
    async sendMedia() {
      return "om_media";
    },
    async startRichCard() {
      return {
        cardId: "card_fixture",
        messageId: "om_stream",
        async update() {},
        async finish() {},
      };
    },
    async addReaction() {
      return "reaction-fixture";
    },
    async removeReaction() {},
    async connect() {
      return { close() {} };
    },
    ...overrides,
  };
}

test("normalizes Feishu group mentions, thread routes, DMs, post text, and media metadata", () => {
  const group = normalizeFeishuEvent(messageEvent(), account(), { openId: "ou_bot", name: "Pi Bot" });
  assert.equal(group.peer.kind, "group");
  assert.equal(group.peer.id, "oc_group");
  assert.equal(group.threadId, "omt_thread");
  assert.equal(group.sender.id, "ou_user");
  assert.equal(group.mentionsBot, true);
  assert.equal(group.text, "please review");
  assert.equal(group.providerContext.replyToMessageId, "om_message_one");

  const dmPost = normalizeFeishuEvent(
    messageEvent({
      message: {
        message_id: "om_post",
        create_time: "1700000000001",
        chat_id: "oc_dm",
        chat_type: "p2p",
        message_type: "post",
        content: JSON.stringify({
          zh_cn: {
            title: "Review",
            content: [[{ tag: "text", text: "line one" }], [{ tag: "a", text: "link" }]],
          },
        }),
      },
    }),
    account(),
    { openId: "ou_bot", name: "Pi Bot" },
  );
  assert.equal(dmPost.peer.kind, "dm");
  assert.equal(dmPost.peer.id, "ou_user");
  assert.equal(dmPost.text, "Review\nline one\nlink");

  const file = normalizeFeishuEvent(
    messageEvent({
      message: {
        message_id: "om_file",
        create_time: "1700000000002",
        chat_id: "oc_dm",
        chat_type: "p2p",
        message_type: "file",
        content: JSON.stringify({ file_key: "file_v2_x", file_name: "notes.txt" }),
      },
    }),
    account(),
    { openId: "ou_bot", name: "Pi Bot" },
  );
  assert.deepEqual(file.attachments, [{ kind: "file", name: "notes.txt" }]);
});

test("downloads accepted Feishu image, file, audio, and video resources before the Agent turn", async () => {
  const controller = new globalThis.AbortController();
  const state = stateStore();
  const requests = [];
  const downloaded = [];
  const events = [
    {
      messageId: "om_image",
      messageType: "image",
      content: { image_key: "img_v2_fixture" },
      expected: { resourceType: "image", kind: "image", fileKey: "img_v2_fixture" },
    },
    {
      messageId: "om_file",
      messageType: "file",
      content: { file_key: "file_v2_fixture", file_name: "notes.txt" },
      expected: { resourceType: "file", kind: "file", fileKey: "file_v2_fixture", name: "notes.txt" },
    },
    {
      messageId: "om_audio",
      messageType: "audio",
      content: { file_key: "file_audio_fixture" },
      expected: {
        resourceType: "file",
        kind: "voice",
        fileKey: "file_audio_fixture",
        name: "voice.opus",
        mime: "audio/ogg",
      },
    },
    {
      messageId: "om_video",
      messageType: "media",
      content: { file_key: "file_video_fixture", file_name: "clip.mp4" },
      expected: {
        resourceType: "file",
        kind: "video",
        fileKey: "file_video_fixture",
        name: "clip.mp4",
        mime: "video/mp4",
      },
    },
  ];
  let index = 0;
  const adapter = new FeishuAdapter(
    dependencies({
      async downloadResource(_credentials, request) {
        requests.push(request);
        return { kind: request.kind, data: Buffer.from(request.fileKey), name: request.name, mime: request.mime };
      },
      async connect(_credentials, handlers) {
        for (const item of events) {
          handlers.onMessage(
            messageEvent({
              message: {
                message_id: item.messageId,
                create_time: String(1700000000000 + index++),
                chat_id: "oc_dm",
                chat_type: "p2p",
                message_type: item.messageType,
                content: JSON.stringify(item.content),
              },
            }),
          );
        }
        return { close() {} };
      },
    }),
  );
  await adapter.start({
    account: account(),
    secret: { token: "app-secret", providerAccountId: "ou_bot", baseUrl: "https://open.feishu.cn" },
    signal: controller.signal,
    state,
    onInbound: async (envelope) => {
      downloaded.push(
        ...(await adapter.downloadInbound({
          account: account(),
          secret: { token: "app-secret", providerAccountId: "ou_bot", baseUrl: "https://open.feishu.cn" },
          envelope,
        })),
      );
      if (downloaded.length === events.length) controller.abort();
    },
    onStatus: () => undefined,
    log: () => undefined,
  });
  assert.equal(downloaded.length, 4);
  assert.deepEqual(
    requests.map((request) => Object.fromEntries(Object.entries(request).filter(([key]) => key !== "messageId"))),
    events.map((item) => item.expected),
  );
  assert.deepEqual(
    requests.map((request) => request.messageId),
    events.map((item) => item.messageId),
  );
});

test("normalizes supported Feishu native menu events into existing DM commands", () => {
  const normalized = normalizeFeishuMenuEvent(
    {
      event_id: "menu-one",
      create_time: "1700000000000",
      operator: { operator_name: "Alice", operator_id: { open_id: "ou_user" } },
      event_key: "pi_compact",
    },
    account({ commandsEnabled: true }),
  );
  assert.equal(normalized.id, "menu-one");
  assert.deepEqual(normalized.peer, { kind: "dm", id: "ou_user" });
  assert.deepEqual(normalized.sender, { id: "ou_user", name: "Alice" });
  assert.equal(normalized.text, "/compact");
  assert.equal(normalized.mentionsBot, true);
  assert.equal(normalizeFeishuMenuEvent({ event_key: "unknown" }, account()), null);
});

test("long-connection runtime acknowledges quickly and suppresses message replay", async () => {
  const controller = new globalThis.AbortController();
  const state = stateStore();
  let inboundCount = 0;
  let closed = false;
  const first = messageEvent();
  const replay = messageEvent({ event_id: "event-redelivered" });
  const adapter = new FeishuAdapter(
    dependencies({
      async connect(_credentials, handlers) {
        handlers.onMessage(first);
        handlers.onMessage(replay);
        return { close: () => (closed = true) };
      },
    }),
  );

  await adapter.start({
    account: account(),
    secret: { token: "app-secret", providerAccountId: "ou_bot", baseUrl: "https://open.feishu.cn" },
    signal: controller.signal,
    state,
    onInbound: async () => {
      inboundCount += 1;
      controller.abort();
    },
    onStatus: () => undefined,
    log: () => undefined,
  });

  assert.equal(inboundCount, 1);
  assert.equal(state.isProcessed("feishu-runtime", "om_message_one"), true);
  assert.equal(closed, true);
});

test("failed Channel Core handling does not persist the Feishu message as processed", async () => {
  const controller = new globalThis.AbortController();
  const state = stateStore();
  const adapter = new FeishuAdapter(
    dependencies({
      async connect(_credentials, handlers) {
        handlers.onMessage(messageEvent({ message: { ...messageEvent().message, message_id: "om_retryable" } }));
        await new Promise((resolve) => setImmediate(resolve));
        controller.abort();
        return { close() {} };
      },
    }),
  );
  await adapter.start({
    account: account(),
    secret: { token: "app-secret", providerAccountId: "ou_bot", baseUrl: "https://open.feishu.cn" },
    signal: controller.signal,
    state,
    onInbound: async () => {
      throw new Error("Agent failed before accepting the turn");
    },
    onStatus: () => undefined,
    log: () => undefined,
  });
  assert.equal(state.isProcessed("feishu-runtime", "om_retryable"), false);
});

test("native Feishu menu dispatches existing commands and suppresses replay", async () => {
  const controller = new globalThis.AbortController();
  const state = stateStore();
  const inbound = [];
  const menu = {
    event_id: "menu-status-one",
    create_time: "1700000000000",
    operator: { operator_name: "Alice", operator_id: { open_id: "ou_user" } },
    event_key: "pi_status",
  };
  const adapter = new FeishuAdapter(
    dependencies({
      async connect(_credentials, handlers) {
        handlers.onMenu(menu);
        handlers.onMenu(menu);
        return { close() {} };
      },
    }),
  );
  await adapter.start({
    account: account({ commandsEnabled: true }),
    secret: { token: "app-secret", providerAccountId: "ou_bot", baseUrl: "https://open.feishu.cn" },
    signal: controller.signal,
    state,
    onInbound: async (envelope) => {
      inbound.push(envelope);
      controller.abort();
    },
    onStatus: () => undefined,
    log: () => undefined,
  });
  assert.equal(inbound.length, 1);
  assert.equal(inbound[0].text, "/status");
  assert.equal(state.isProcessed("feishu-runtime", "menu:menu-status-one"), true);
});

test("native Feishu menu is ignored when channel commands are disabled", async () => {
  const controller = new globalThis.AbortController();
  const state = stateStore();
  let inboundCount = 0;
  const adapter = new FeishuAdapter(
    dependencies({
      async connect(_credentials, handlers) {
        handlers.onMenu({
          event_id: "menu-disabled",
          operator: { operator_id: { open_id: "ou_user" } },
          event_key: "pi_help",
        });
        controller.abort();
        return { close() {} };
      },
    }),
  );
  await adapter.start({
    account: account({ commandsEnabled: false }),
    secret: { token: "app-secret", providerAccountId: "ou_bot", baseUrl: "https://open.feishu.cn" },
    signal: controller.signal,
    state,
    onInbound: async () => {
      inboundCount += 1;
    },
    onStatus: () => undefined,
    log: () => undefined,
  });
  assert.equal(inboundCount, 0);
  assert.equal(state.isProcessed("feishu-runtime", "menu:menu-disabled"), true);
});

test("text replies preserve the source message and thread across chunks", async () => {
  const requests = [];
  const adapter = new FeishuAdapter(
    dependencies({
      async sendText(_credentials, request) {
        requests.push(request);
        return `om_sent_${requests.length}`;
      },
    }),
  );
  const receipt = await adapter.send({
    account: account(),
    secret: { token: "app-secret", providerAccountId: "ou_bot", baseUrl: "https://open.feishu.cn" },
    peerId: "oc_group",
    text: `${"a".repeat(20_000)}${"b".repeat(20_000)}`,
    threadId: "omt_thread",
    replyToMessageId: "om_source",
  });

  assert.equal(requests.length, 2);
  assert.equal(
    requests.every((request) => request.replyToMessageId === "om_source"),
    true,
  );
  assert.equal(
    requests.every((request) => request.replyInThread === true),
    true,
  );
  assert.equal(receipt.messageId, "om_sent_2");
  assert.equal(receipt.channel, "feishu");
});

test("media replies preserve Feishu thread routing and return the final attachment receipt", async () => {
  const requests = [];
  const adapter = new FeishuAdapter(
    dependencies({
      async sendMedia(_credentials, request) {
        requests.push(request);
        return `om_media_${requests.length}`;
      },
    }),
  );
  const result = await adapter.send({
    account: account(),
    secret: { token: "app-secret", providerAccountId: "ou_bot", baseUrl: "https://open.feishu.cn" },
    peerId: "oc_group",
    text: "",
    threadId: "omt_thread",
    replyToMessageId: "om_source",
    attachments: [
      { kind: "image", path: "/workspace/chart.png", name: "chart.png", mime: "image/png" },
      { kind: "file", path: "/workspace/report.pdf", name: "report.pdf", mime: "application/pdf" },
    ],
  });
  assert.equal(requests.length, 2);
  assert.equal(
    requests.every((request) => request.replyToMessageId === "om_source"),
    true,
  );
  assert.equal(
    requests.every((request) => request.replyInThread === true),
    true,
  );
  assert.equal(result.messageId, "om_media_2");
});

test("progressive turns stream process and Markdown then fold details in the final card", async () => {
  const starts = [];
  const updates = [];
  const finishes = [];
  const reactions = [];
  const removedReactions = [];
  const adapter = new FeishuAdapter(
    dependencies({
      async startRichCard(_credentials, request) {
        starts.push(request);
        return {
          cardId: "card_stream",
          messageId: "om_stream",
          async update(content) {
            updates.push(content);
          },
          async finish(card) {
            finishes.push(card);
          },
        };
      },
      async addReaction(_credentials, messageId, emojiType) {
        reactions.push({ messageId, emojiType });
        return `reaction-${emojiType}`;
      },
      async removeReaction(_credentials, messageId, reactionId) {
        removedReactions.push({ messageId, reactionId });
      },
    }),
    0,
  );
  const output = adapter.beginTurn({
    account: account(),
    secret: { token: "app-secret", providerAccountId: "ou_bot", baseUrl: "https://open.feishu.cn" },
    peerId: "oc_group",
    peerKind: "group",
    threadId: "omt_thread",
    replyToMessageId: "om_source",
    runId: "om_source",
  });
  output.update({
    type: "message",
    phase: "update",
    message: {
      role: "assistant",
      model: "fixture",
      provider: "fixture",
      content: [
        { type: "thinking", thinking: "检查代码" },
        { type: "text", text: "正在输出 **Markdown**" },
      ],
    },
  });
  output.update({ type: "tool_start", toolCallId: "tool-1", toolName: "read", args: { path: "README.md" } });
  await new Promise((resolve) => setTimeout(resolve, 10));
  const result = await output.finish("## 最终答案\n\n- 支持 Markdown");
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(starts.length, 1);
  assert.equal(starts[0].replyToMessageId, "om_source");
  assert.equal(starts[0].replyInThread, true);
  assert.equal(starts[0].card.config.streaming_mode, true);
  assert.equal(updates.length, 1);
  assert.match(updates[0], /检查代码/);
  assert.match(updates[0], /工具 · read · 运行中/);
  assert.equal(finishes.length, 1);
  assert.equal(finishes[0].config.streaming_mode, false);
  assert.equal(finishes[0].body.elements[0].tag, "collapsible_panel");
  assert.equal(finishes[0].body.elements[0].expanded, false);
  assert.match(finishes[0].body.elements.at(-1).content, /## 最终答案/);
  assert.deepEqual(reactions, [
    { messageId: "om_source", emojiType: "THINKING" },
    { messageId: "om_source", emojiType: "DONE" },
  ]);
  assert.deepEqual(removedReactions, [{ messageId: "om_source", reactionId: "reaction-THINKING" }]);
  assert.equal(result.messageId, "om_stream");
});

test("Feishu reaction failures never prevent a durable final reply", async () => {
  const adapter = new FeishuAdapter(
    dependencies({
      async addReaction() {
        throw new Error("reaction permission unavailable");
      },
    }),
    0,
  );
  const output = adapter.beginTurn({
    account: account(),
    secret: { token: "app-secret", providerAccountId: "ou_bot", baseUrl: "https://open.feishu.cn" },
    peerId: "ou_user",
    peerKind: "dm",
    replyToMessageId: "om_source",
    runId: "reaction-failure",
  });
  const result = await output.finish("最终答案");
  assert.equal(result.messageId, "om_card");
});

test("missing CardKit permission falls back to one durable Markdown card without losing the answer", async () => {
  const cards = [];
  const plain = [];
  const adapter = new FeishuAdapter(
    dependencies({
      async startRichCard() {
        throw new FeishuApiError("创建流式卡片失败（99991663）：permission denied", 99991663);
      },
      async sendCard(_credentials, request) {
        cards.push(request.card);
        return "om_final_card";
      },
      async sendText(_credentials, request) {
        plain.push(request.text);
        return "om_plain";
      },
    }),
    0,
  );
  const output = adapter.beginTurn({
    account: account(),
    secret: { token: "app-secret", providerAccountId: "ou_bot", baseUrl: "https://open.feishu.cn" },
    peerId: "ou_user",
    peerKind: "dm",
    replyToMessageId: "om_source",
    runId: "om_source",
  });
  await new Promise((resolve) => setTimeout(resolve, 10));
  const result = await output.finish("**即使没有 CardKit 权限也保留 Markdown**");

  assert.equal(cards.length, 1);
  assert.match(cards[0].body.elements.at(-1).content, /\*\*即使没有 CardKit 权限也保留 Markdown\*\*/);
  assert.deepEqual(plain, []);
  assert.equal(result.messageId, "om_final_card");
});

test("a streaming update failure is isolated and the existing card still receives the final answer", async () => {
  const finishes = [];
  const adapter = new FeishuAdapter(
    dependencies({
      async startRichCard() {
        return {
          cardId: "card_update_failure",
          messageId: "om_existing",
          async update() {
            throw new Error("temporary update failure");
          },
          async finish(card) {
            finishes.push(card);
          },
        };
      },
    }),
    0,
  );
  const output = adapter.beginTurn({
    account: account(),
    secret: { token: "app-secret", providerAccountId: "ou_bot", baseUrl: "https://open.feishu.cn" },
    peerId: "ou_user",
    peerKind: "dm",
    replyToMessageId: "om_source",
    runId: "om_source",
  });
  await new Promise((resolve) => setTimeout(resolve, 10));
  const result = await output.finish("**最终答案仍然可见**");
  assert.equal(finishes.length, 1);
  assert.match(finishes[0].body.elements.at(-1).content, /最终答案仍然可见/);
  assert.equal(result.messageId, "om_existing");
});

test("an ambiguous streaming-card send failure never creates a duplicate fallback message", async () => {
  let cardSends = 0;
  let plainSends = 0;
  const adapter = new FeishuAdapter(
    dependencies({
      async startRichCard() {
        throw new FeishuApiError("发送流式卡片失败：network timeout", undefined, true);
      },
      async sendCard() {
        cardSends += 1;
        return "om_duplicate";
      },
      async sendText() {
        plainSends += 1;
        return "om_duplicate_plain";
      },
    }),
    0,
  );
  const output = adapter.beginTurn({
    account: account(),
    secret: { token: "app-secret", providerAccountId: "ou_bot", baseUrl: "https://open.feishu.cn" },
    peerId: "ou_user",
    peerKind: "dm",
    replyToMessageId: "om_source",
    runId: "om_source",
  });
  await new Promise((resolve) => setTimeout(resolve, 10));
  await assert.rejects(output.finish("不要重复发送"), /network timeout/);
  assert.equal(cardSends, 0);
  assert.equal(plainSends, 0);
});

test("probe reports the bot identity and domain without exposing App Secret", async () => {
  const adapter = new FeishuAdapter(dependencies());
  const result = await adapter.probe(account({ domain: "lark" }), {
    token: "never-return-this",
    providerAccountId: "ou_bot",
    baseUrl: "https://open.larksuite.com",
  });
  assert.equal(result.ok, true);
  assert.equal(result.providerAccountId, "ou_bot");
  assert.match(result.message, /Lark Pi Bot/);
  assert.doesNotMatch(result.message, /never-return-this/);
});
