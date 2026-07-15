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
  `telegram-adapter-runtime-${process.pid}.mjs`,
);
mkdirSync(path.dirname(output), { recursive: true });
await build({
  stdin: {
    contents: [
      'export { TelegramAdapter, normalizeTelegramUpdate } from "./adapter.ts";',
      'export { ChannelStateStore } from "../../state-store.ts";',
    ].join("\n"),
    resolveDir: import.meta.dirname,
    sourcefile: "telegram-adapter-runtime-test-entry.ts",
    loader: "ts",
  },
  outfile: output,
  bundle: true,
  format: "esm",
  platform: "node",
  packages: "external",
  logLevel: "silent",
});

const { ChannelStateStore, TelegramAdapter, normalizeTelegramUpdate } = await import(
  `${pathToFileURL(output).href}?v=${Date.now()}`
);

function jsonResponse(value, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? "OK" : "Error",
    json: async () => value,
  };
}

function account(overrides = {}) {
  const now = new Date().toISOString();
  return {
    id: "telegram-runtime",
    channel: "telegram",
    name: "@pi_bot",
    enabled: true,
    providerAccountId: "42",
    providerUsername: "@pi_bot",
    baseUrl: "https://telegram.example",
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

function createStatePath() {
  const dir = mkdtempSync(path.join(tmpdir(), "pi-telegram-runtime-"));
  return path.join(dir, "state.json");
}

function botResult() {
  return { ok: true, result: { id: 42, is_bot: true, first_name: "Pi", username: "pi_bot" } };
}

function dmUpdate(updateId = 100, text = "hello") {
  return {
    update_id: updateId,
    message: {
      message_id: 10,
      date: 1_700_000_000,
      chat: { id: 7, type: "private", first_name: "Alice" },
      from: { id: 7, is_bot: false, first_name: "Alice", username: "alice" },
      text,
    },
  };
}

test("normalizes DM, group topic, mention, reply context, and attachment metadata", () => {
  const normalized = normalizeTelegramUpdate(
    {
      update_id: 200,
      message: {
        message_id: 25,
        message_thread_id: 9,
        is_topic_message: true,
        date: 1_700_000_000,
        chat: { id: -1001, type: "supergroup", title: "Developers", is_forum: true },
        from: { id: 8, is_bot: false, first_name: "Bob" },
        text: "@pi_bot review this",
        entities: [{ type: "mention", offset: 0, length: 7 }],
        photo: [{ file_id: "photo" }],
        document: { file_id: "doc", file_name: "notes.txt", mime_type: "text/plain" },
        reply_to_message: {
          message_id: 21,
          date: 1_699_999_999,
          chat: { id: -1001, type: "supergroup" },
          from: { id: 7, is_bot: false, first_name: "Alice" },
          text: "previous message",
        },
      },
    },
    account(),
    { id: 42, username: "pi_bot" },
  );
  assert.equal(normalized.peer.kind, "group");
  assert.equal(normalized.peer.id, "-1001");
  assert.equal(normalized.threadId, "9");
  assert.equal(normalized.sender.id, "8");
  assert.equal(normalized.mentionsBot, true);
  assert.equal(normalized.text, "review this");
  assert.deepEqual(normalized.replyTo, { messageId: "21", text: "previous message", senderId: "7" });
  assert.equal(normalized.providerContext.replyToMessageId, "25");
  assert.deepEqual(normalized.attachments, [
    { kind: "image", mime: "image/jpeg" },
    { kind: "file", name: "notes.txt", mime: "text/plain" },
  ]);
});

test("normalizes a basic Telegram group independently of forum topic support", () => {
  const normalized = normalizeTelegramUpdate(
    {
      update_id: 201,
      message: {
        message_id: 26,
        date: 1_700_000_001,
        chat: { id: -12345, type: "group", title: "Basic group" },
        from: { id: 9, is_bot: false, first_name: "Carol" },
        text: "/status@pi_bot",
        entities: [{ type: "bot_command", offset: 0, length: 14 }],
      },
    },
    account(),
    { id: 42, username: "pi_bot" },
  );
  assert.equal(normalized.peer.kind, "group");
  assert.equal(normalized.peer.id, "-12345");
  assert.equal(normalized.threadId, undefined);
  assert.equal(normalized.sender.id, "9");
  assert.equal(normalized.mentionsBot, true);
  assert.equal(normalized.text, "/status");
});

test("runtime checkpoints update offset and suppresses replay after Host restart", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  const statePath = createStatePath();
  let controller = new globalThis.AbortController();
  let inboundCount = 0;
  let updateCalls = 0;
  const offsets = [];
  globalThis.fetch = async (url, init) => {
    const endpoint = String(url);
    if (endpoint.endsWith("/getMe")) return jsonResponse(botResult());
    if (endpoint.endsWith("/getUpdates")) {
      updateCalls += 1;
      const body = JSON.parse(init.body);
      offsets.push(body.offset);
      if (updateCalls === 1) return jsonResponse({ ok: true, result: [dmUpdate()] });
      if (updateCalls === 2) return jsonResponse({ ok: true, result: [dmUpdate()] });
      controller.abort();
      return jsonResponse({ ok: true, result: [] });
    }
    throw new Error(`Unexpected Telegram endpoint: ${endpoint}`);
  };

  const run = async (state) =>
    new TelegramAdapter().start({
      account: account(),
      secret: {
        token: "token",
        providerAccountId: "42",
        providerUsername: "@pi_bot",
        baseUrl: "https://telegram.example",
      },
      signal: controller.signal,
      state,
      onInbound: async () => {
        inboundCount += 1;
        if (inboundCount === 1) controller.abort();
      },
      onStatus: () => undefined,
      log: () => undefined,
    });

  const firstState = new ChannelStateStore(statePath);
  await run(firstState);
  assert.equal(firstState.getCursor("telegram-runtime"), "101");
  assert.equal(firstState.isProcessed("telegram-runtime", "100"), true);

  controller = new globalThis.AbortController();
  await run(new ChannelStateStore(statePath));
  assert.equal(inboundCount, 1);
  assert.deepEqual(offsets, [undefined, 101, 101]);
});

test("runtime retries a transient getMe failure during offline startup", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  let getMeCalls = 0;
  const delays = [];
  globalThis.fetch = async (url) => {
    if (String(url).endsWith("/getMe")) {
      getMeCalls += 1;
      if (getMeCalls === 1) throw new Error("offline at startup");
      return jsonResponse(botResult());
    }
    return jsonResponse({ ok: true, result: [dmUpdate(250, "connected after startup")] });
  };
  const controller = new globalThis.AbortController();
  const statuses = [];
  await new TelegramAdapter(async (ms) => delays.push(ms)).start({
    account: account(),
    secret: { token: "token", providerAccountId: "42", baseUrl: "https://telegram.example" },
    signal: controller.signal,
    state: new ChannelStateStore(createStatePath()),
    onInbound: async () => controller.abort(),
    onStatus: (status) => statuses.push(status),
    log: () => undefined,
  });
  assert.equal(getMeCalls, 2);
  assert.deepEqual(delays, [2_000]);
  assert.equal(
    statuses.some((status) => status.state === "reconnecting" && status.retryCount === 1),
    true,
  );
});

test("runtime syncs the opt-in command menu without making menu failures fatal", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  let controller = new globalThis.AbortController();
  let commandBody;
  globalThis.fetch = async (url, init) => {
    const endpoint = String(url);
    if (endpoint.endsWith("/getMe")) return jsonResponse(botResult());
    if (endpoint.endsWith("/setMyCommands")) {
      commandBody = JSON.parse(init.body);
      return jsonResponse({ ok: true, result: true });
    }
    controller.abort();
    return jsonResponse({ ok: true, result: [] });
  };
  await new TelegramAdapter().start({
    account: account({ commandsEnabled: true }),
    secret: { token: "token", providerAccountId: "42", baseUrl: "https://telegram.example" },
    signal: controller.signal,
    state: new ChannelStateStore(createStatePath()),
    onInbound: async () => undefined,
    onStatus: () => undefined,
    log: () => undefined,
  });
  assert.deepEqual(
    commandBody.commands.map((item) => item.command),
    ["help", "status", "new", "compact", "reload"],
  );

  controller = new globalThis.AbortController();
  const logs = [];
  globalThis.fetch = async (url) => {
    const endpoint = String(url);
    if (endpoint.endsWith("/getMe")) return jsonResponse(botResult());
    if (endpoint.endsWith("/setMyCommands")) {
      return jsonResponse({ ok: false, error_code: 500, description: "menu unavailable" }, 500);
    }
    controller.abort();
    return jsonResponse({ ok: true, result: [] });
  };
  await new TelegramAdapter().start({
    account: account({ commandsEnabled: true }),
    secret: { token: "token", providerAccountId: "42", baseUrl: "https://telegram.example" },
    signal: controller.signal,
    state: new ChannelStateStore(createStatePath()),
    onInbound: async () => undefined,
    onStatus: () => undefined,
    log: (message) => logs.push(message),
  });
  assert.match(logs[0], /命令菜单同步失败/);
});

test("runtime reconnects after a transient failure and fails closed on 409 conflicts", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  let mode = "reconnect";
  let updateCalls = 0;
  globalThis.fetch = async (url) => {
    if (String(url).endsWith("/getMe")) return jsonResponse(botResult());
    updateCalls += 1;
    if (mode === "reconnect" && updateCalls === 1) throw new Error("network offline");
    if (mode === "reconnect") return jsonResponse({ ok: true, result: [dmUpdate(300, "back online")] });
    return jsonResponse({ ok: false, error_code: 409, description: "Conflict: terminated by other getUpdates" }, 409);
  };

  const controller = new globalThis.AbortController();
  const statuses = [];
  await new TelegramAdapter(async () => undefined).start({
    account: account(),
    secret: { token: "token", providerAccountId: "42", baseUrl: "https://telegram.example" },
    signal: controller.signal,
    state: new ChannelStateStore(createStatePath()),
    onInbound: async () => controller.abort(),
    onStatus: (status) => statuses.push(status),
    log: () => undefined,
  });
  assert.equal(
    statuses.some((status) => status.state === "reconnecting" && status.retryCount === 1),
    true,
  );

  mode = "conflict";
  updateCalls = 0;
  await assert.rejects(
    new TelegramAdapter(async () => undefined).start({
      account: account(),
      secret: { token: "token", providerAccountId: "42", baseUrl: "https://telegram.example" },
      signal: new globalThis.AbortController().signal,
      state: new ChannelStateStore(createStatePath()),
      onInbound: async () => undefined,
      onStatus: () => undefined,
      log: () => undefined,
    }),
    /polling 冲突/,
  );
  assert.equal(updateCalls, 1);
});

test("send retries 429, escapes HTML, and splits long Unicode text", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  const requests = [];
  let calls = 0;
  let richCalls = 0;
  globalThis.fetch = async (url, init) => {
    calls += 1;
    const endpoint = String(url).split("/").at(-1);
    requests.push({ endpoint, body: JSON.parse(init.body) });
    if (endpoint === "sendRichMessage") {
      richCalls += 1;
    }
    if (endpoint === "sendRichMessage" && richCalls === 1) {
      return jsonResponse(
        { ok: false, error_code: 429, description: "Too Many Requests", parameters: { retry_after: 1 } },
        429,
      );
    }
    if (endpoint === "sendRichMessage") {
      return jsonResponse({ ok: false, error_code: 400, description: "Rich Messages unsupported" }, 400);
    }
    return jsonResponse({
      ok: true,
      result: { message_id: calls, date: 1, chat: { id: 7, type: "private" } },
    });
  };
  const receipt = await new TelegramAdapter(async () => undefined).send({
    account: account(),
    secret: { token: "token", providerAccountId: "42", baseUrl: "https://telegram.example" },
    peerId: "7",
    text: `<unsafe & text>\n\n${"🙂".repeat(4_050)}`,
    replyToMessageId: "10",
  });
  assert.equal(calls >= 3, true);
  const successfulBodies = requests
    .filter((request) => request.endpoint === "sendMessage")
    .map((request) => request.body);
  assert.match(successfulBodies.map((body) => body.text).join(""), /^&lt;unsafe &amp; text&gt;/);
  assert.equal(
    successfulBodies.some((body) => body.text.includes("<unsafe")),
    false,
  );
  assert.equal(successfulBodies[0].reply_parameters.message_id, 10);
  assert.equal(successfulBodies.at(-1).reply_parameters, undefined);
  assert.equal(receipt.messageId, String(calls));
});

test("sendRichMessage preserves Markdown and blocks model-injected Rich HTML", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  let request;
  globalThis.fetch = async (url, init) => {
    request = { endpoint: String(url).split("/").at(-1), body: JSON.parse(init.body) };
    return jsonResponse({
      ok: true,
      result: { message_id: 80, date: 1, chat: { id: 7, type: "private" } },
    });
  };

  const receipt = await new TelegramAdapter(async () => undefined).send({
    account: account(),
    secret: { token: "token", providerAccountId: "42", baseUrl: "https://telegram.example" },
    peerId: "7",
    text: "## 标题\n\n**加粗** <details open>不能注入</details>",
  });

  assert.equal(request.endpoint, "sendRichMessage");
  assert.match(request.body.rich_message.markdown, /^## 标题\n\n\*\*加粗\*\*/);
  assert.match(request.body.rich_message.markdown, /&lt;details open&gt;不能注入&lt;\/details&gt;/);
  assert.equal(request.body.rich_message.skip_entity_detection, true);
  assert.equal(receipt.messageId, "80");
});

test("an ambiguous Rich Message network failure does not trigger a duplicate plain send", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  const endpoints = [];
  globalThis.fetch = async (url) => {
    endpoints.push(String(url).split("/").at(-1));
    throw new TypeError("network offline");
  };

  await assert.rejects(
    new TelegramAdapter(async () => undefined).send({
      account: account(),
      secret: { token: "token", providerAccountId: "42", baseUrl: "https://telegram.example" },
      peerId: "7",
      text: "最终答案",
    }),
    /network offline/,
  );
  assert.deepEqual(endpoints, ["sendRichMessage"]);
});

test("private turns stream Rich drafts and persist folded process details", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  const requests = [];
  globalThis.fetch = async (url, init) => {
    const endpoint = String(url).split("/").at(-1);
    requests.push({ endpoint, body: JSON.parse(init.body) });
    return endpoint === "sendRichMessage"
      ? jsonResponse({ ok: true, result: { message_id: 81, date: 1, chat: { id: 7, type: "private" } } })
      : jsonResponse({ ok: true, result: true });
  };
  const adapter = new TelegramAdapter(async () => undefined, 0);
  const output = adapter.beginTurn({
    account: account(),
    secret: { token: "token", providerAccountId: "42", baseUrl: "https://telegram.example" },
    peerId: "7",
    peerKind: "dm",
    replyToMessageId: "10",
    runId: "run-rich-one",
  });
  output.update({
    type: "message",
    phase: "update",
    message: {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "先检查配置" },
        { type: "text", text: "正在生成 **答案**" },
        { type: "toolCall", toolCallId: "tool-one", toolName: "read", input: { token: "secret" } },
      ],
    },
  });
  output.update({
    type: "tool_start",
    toolCallId: "tool-one",
    toolName: "read",
    args: { token: "secret" },
  });
  await new Promise((resolve) => setTimeout(resolve, 10));
  output.update({
    type: "tool_end",
    toolCallId: "tool-one",
    toolName: "read",
    result: "读取完成",
    isError: false,
  });
  await new Promise((resolve) => setTimeout(resolve, 5));
  const receipt = await output.finish("## 完成\n\n**最终答案**");
  await new Promise((resolve) => setImmediate(resolve));

  const drafts = requests.filter((request) => request.endpoint === "sendRichMessageDraft");
  assert.equal(drafts.length >= 2, true);
  assert.equal(
    new Set(drafts.map((draft) => draft.body.draft_id)).size,
    1,
    "updates for one turn must animate the same Telegram draft",
  );
  assert.match(drafts[0].body.rich_message.markdown, /^<tg-thinking>/);
  assert.match(drafts[0].body.rich_message.markdown, /<details open><summary>思考过程<\/summary>/);
  assert.match(drafts[0].body.rich_message.markdown, /\[REDACTED\]/);
  const final = requests.find((request) => request.endpoint === "sendRichMessage");
  assert.doesNotMatch(final.body.rich_message.markdown, /<tg-thinking>/);
  assert.doesNotMatch(final.body.rich_message.markdown, /<details open>/);
  assert.match(final.body.rich_message.markdown, /<details><summary>工具 · read · 完成<\/summary>/);
  assert.match(final.body.rich_message.markdown, /## 完成\n\n\*\*最终答案\*\*/);
  assert.equal(final.body.reply_parameters.message_id, 10);
  assert.deepEqual(
    requests
      .filter((request) => request.endpoint === "setMessageReaction")
      .map((request) => request.body.reaction[0].emoji),
    ["👀", "👍"],
  );
  assert.equal(receipt.messageId, "81");
});

test("Telegram reaction failures never prevent a durable final reply", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  const endpoints = [];
  globalThis.fetch = async (url) => {
    const endpoint = String(url).split("/").at(-1);
    endpoints.push(endpoint);
    if (endpoint === "setMessageReaction") {
      return jsonResponse({ ok: false, error_code: 400, description: "REACTION_INVALID" }, 400);
    }
    return jsonResponse({
      ok: true,
      result: { message_id: 84, date: 1, chat: { id: 7, type: "private" } },
    });
  };
  const output = new TelegramAdapter(async () => undefined, 0).beginTurn({
    account: account(),
    secret: { token: "token", providerAccountId: "42", baseUrl: "https://telegram.example" },
    peerId: "7",
    peerKind: "dm",
    replyToMessageId: "10",
    runId: "run-reaction-failure",
  });
  const receipt = await output.finish("最终答案");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(receipt.messageId, "84");
  assert.ok(endpoints.includes("sendRichMessage"));
});

test("group turns skip ephemeral drafts and send only a Rich final message", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  const endpoints = [];
  globalThis.fetch = async (url) => {
    endpoints.push(String(url).split("/").at(-1));
    return jsonResponse({
      ok: true,
      result: { message_id: 82, date: 1, chat: { id: -1001, type: "supergroup" } },
    });
  };
  const output = new TelegramAdapter(async () => undefined, 0).beginTurn({
    account: account(),
    secret: { token: "token", providerAccountId: "42", baseUrl: "https://telegram.example" },
    peerId: "-1001",
    peerKind: "group",
    threadId: "9",
    runId: "run-group-one",
  });
  output.update({
    type: "message",
    phase: "update",
    message: { role: "assistant", content: [{ type: "text", text: "partial" }] },
  });
  await new Promise((resolve) => setTimeout(resolve, 5));
  await output.finish("## 群聊最终回复");

  assert.deepEqual(endpoints, ["sendRichMessage"]);
});

test("malformed tool progress cannot escape the Telegram draft timer", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  const requests = [];
  globalThis.fetch = async (url, init) => {
    const endpoint = String(url).split("/").at(-1);
    requests.push({ endpoint, body: JSON.parse(init.body) });
    return endpoint === "sendRichMessage"
      ? jsonResponse({ ok: true, result: { message_id: 83, date: 1, chat: { id: 7, type: "private" } } })
      : jsonResponse({ ok: true, result: true });
  };
  const hostileValue = new Proxy(
    {},
    {
      ownKeys() {
        throw new Error("cannot enumerate");
      },
      get(_target, key) {
        if (key === Symbol.toPrimitive)
          return () => {
            throw new Error("cannot stringify");
          };
        return undefined;
      },
    },
  );
  const output = new TelegramAdapter(async () => undefined, 0).beginTurn({
    account: account(),
    secret: { token: "token", providerAccountId: "42", baseUrl: "https://telegram.example" },
    peerId: "7",
    peerKind: "dm",
    runId: "run-hostile-tool",
  });
  output.update({
    type: "tool_start",
    toolCallId: "tool-hostile",
    toolName: undefined,
    args: hostileValue,
  });
  await new Promise((resolve) => setTimeout(resolve, 5));
  const receipt = await output.finish("最终回复");

  const draft = requests.find((request) => request.endpoint === "sendRichMessageDraft");
  assert.match(draft.body.rich_message.markdown, /工具 · tool · 运行中/);
  assert.match(draft.body.rich_message.markdown, /无法序列化的工具输出/);
  assert.equal(requests.at(-1).endpoint, "sendRichMessage");
  assert.equal(receipt.messageId, "83");
});
