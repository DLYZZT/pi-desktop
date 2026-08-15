import { importTestBundle } from "#test-bundle";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
const { AdapterRegistry, ChannelManager } = await importTestBundle("src/agent-host/channels/channel-manager", {
  packages: "external",
  stdin: {
    contents: [
      'export { AdapterRegistry } from "./adapter-registry.ts";',
      'export { ChannelManager } from "./channel-manager.ts";',
    ].join("\n"),
    resolveDir: import.meta.dirname,
    sourcefile: "channel-manager-test-entry.ts",
    loader: "ts",
  },
});

function createFakeAdapter(id = "weixin") {
  let inbound;
  let startCount = 0;
  let activeCount = 0;
  let maxActiveCount = 0;
  const sent = [];
  return {
    adapter: {
      id,
      async start(context) {
        startCount += 1;
        activeCount += 1;
        maxActiveCount = Math.max(maxActiveCount, activeCount);
        inbound = context.onInbound;
        context.onStatus({ state: "running", connected: true });
        try {
          await new Promise((resolve) => context.signal.addEventListener("abort", resolve, { once: true }));
        } finally {
          activeCount -= 1;
        }
      },
      async send(context) {
        sent.push(context);
        return {
          id: `receipt-${sent.length}`,
          channel: id,
          accountId: context.account.id,
          peerId: context.peerId,
          messageId: `message-${sent.length}`,
          deliveredAt: new Date().toISOString(),
        };
      },
      async probe(account) {
        return { ok: true, message: "ok", accountId: account.id };
      },
      async startLogin() {
        throw new Error("not used");
      },
      async pollLogin() {
        throw new Error("not used");
      },
      submitLoginCode() {},
      cancelLogin() {},
    },
    emit: async (envelope) => inbound(envelope),
    sent,
    get startCount() {
      return startCount;
    },
    get activeCount() {
      return activeCount;
    },
    get maxActiveCount() {
      return maxActiveCount;
    },
  };
}

function scanAccountId(domain, appId) {
  return `feishu-${createHash("sha256").update(`${domain}\0${appId}`).digest("hex").slice(0, 24)}`;
}

test("concurrent starts create only one adapter runtime per account", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "pi-channel-manager-concurrent-start-"));
  const fake = createFakeAdapter();
  const registry = new AdapterRegistry();
  registry.register(fake.adapter);
  let blockSecretReads = false;
  let blockedSecretReads = 0;
  let releaseSecretReads;
  let secretGate = Promise.resolve();
  const manager = new ChannelManager({ handle() {}, attachPort() {}, detachPort() {}, emit() {} }, () => {}, {
    dataDirectory: dir,
    registry,
    secretAccess: {
      get: async () => {
        if (blockSecretReads) {
          blockedSecretReads += 1;
          await secretGate;
        }
        return { token: "token", providerAccountId: "raw", baseUrl: "https://example.test" };
      },
      set: async () => {},
      delete: async () => {},
    },
    bridge: { async runTurn() {} },
  });
  const now = new Date().toISOString();
  await manager.upsertAccount({
    id: "wx-concurrent",
    channel: "weixin",
    name: "Concurrent Weixin",
    enabled: true,
    dmPolicy: "open",
    allowFrom: [],
    groupPolicy: "disabled",
    groupIds: [],
    groupAllowFrom: [],
    requireMention: true,
    toolNames: [],
    createdAt: now,
    updatedAt: now,
  });
  await manager.stopAccount("wx-concurrent");

  blockSecretReads = true;
  secretGate = new Promise((resolve) => {
    releaseSecretReads = resolve;
  });
  const starts = Array.from({ length: 20 }, () => manager.startAccount("wx-concurrent"));
  await new Promise((resolve) => setImmediate(resolve));
  releaseSecretReads();
  await Promise.all(starts);

  assert.equal(blockedSecretReads, 1);
  assert.equal(fake.startCount, 2, "setup and concurrent calls should create two runtimes in total");
  assert.equal(fake.activeCount, 1);
  assert.equal(fake.maxActiveCount, 1);

  await manager.stopAccount("wx-concurrent");
  secretGate = new Promise((resolve) => {
    releaseSecretReads = resolve;
  });
  const pendingStart = manager.startAccount("wx-concurrent");
  await new Promise((resolve) => setImmediate(resolve));
  const pendingStop = manager.stopAccount("wx-concurrent");
  releaseSecretReads();
  await Promise.all([pendingStart, pendingStop]);
  assert.equal(fake.startCount, 2, "a stop during credential lookup must cancel the pending adapter launch");
  assert.equal(fake.activeCount, 0);
  await manager.shutdown();
});

test("initialization can retry after a transient media directory failure", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "pi-channel-manager-init-retry-"));
  const mediaPath = path.join(dir, "channel-media");
  await writeFile(mediaPath, "temporarily blocked");
  const manager = new ChannelManager({ handle() {}, attachPort() {}, detachPort() {}, emit() {} }, () => {}, {
    dataDirectory: dir,
  });

  await assert.rejects(manager.initialize(), /EEXIST|媒体暂存目录不是安全的本地目录/);
  await rm(mediaPath, { force: true });
  await manager.initialize();
  const info = await stat(mediaPath);
  assert.equal(info.isDirectory(), true);
  await manager.shutdown();
});

test("fake adapter runs inbound message through binding, Pi bridge, and delivery", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "pi-channel-manager-"));
  const fake = createFakeAdapter();
  const registry = new AdapterRegistry();
  registry.register(fake.adapter);
  const secrets = new Map([
    ["wx-one", { token: "token", providerAccountId: "raw@im.bot", baseUrl: "https://example.test" }],
  ]);
  const events = [];
  const server = {
    handle() {},
    attachPort() {},
    detachPort() {},
    emit(topic, key, data) {
      events.push({ topic, key, data });
    },
  };
  const bridgeCalls = [];
  const manager = new ChannelManager(server, () => {}, {
    dataDirectory: dir,
    registry,
    secretAccess: {
      get: async (_channel, id) => secrets.get(id) ?? null,
      set: async (_channel, id, secret) => secrets.set(id, secret),
      delete: async (_channel, id) => secrets.delete(id),
    },
    bridge: {
      async runTurn(binding, envelope) {
        bridgeCalls.push({ binding, envelope });
        return { sessionId: "session-one", finalText: "agent reply", generatedFiles: [] };
      },
    },
  });
  const now = new Date().toISOString();
  await manager.upsertAccount({
    id: "wx-one",
    channel: "weixin",
    name: "Weixin",
    enabled: true,
    dmPolicy: "pairing",
    allowFrom: ["user-one"],
    groupPolicy: "disabled",
    groupIds: [],
    groupAllowFrom: [],
    requireMention: true,
    defaultCwd: path.join(dir, "workspace"),
    toolNames: [],
    createdAt: now,
    updatedAt: now,
  });

  await fake.emit({
    id: "event-one",
    channel: "weixin",
    accountId: "wx-one",
    peer: { kind: "dm", id: "user-one" },
    sender: { id: "user-one" },
    text: "hello",
    mentionsBot: false,
    attachments: [],
    timestamp: Date.now(),
    providerContext: { contextToken: "context-one" },
  });

  assert.equal(bridgeCalls.length, 1);
  assert.equal(fake.sent.at(-1).text, "agent reply");
  assert.equal(fake.sent.at(-1).contextToken, "context-one");
  const snapshot = await manager.snapshot();
  assert.equal(snapshot.bindings[0].sessionId, "session-one");
  assert.equal(
    snapshot.activities.some((activity) => activity.outcome === "sent"),
    true,
  );
  const firstSessionChanges = events.filter((event) => event.topic === "sessions.changed");
  assert.equal(firstSessionChanges.length, 1);
  assert.equal(firstSessionChanges[0].data.sessionId, "session-one");
  assert.equal(
    events.some(
      (event) =>
        event.topic === "channels.binding" &&
        event.data.action === "upsert" &&
        event.data.binding?.sessionId === "session-one",
    ),
    true,
  );

  await fake.emit({
    id: "event-two",
    channel: "weixin",
    accountId: "wx-one",
    peer: { kind: "dm", id: "user-one" },
    sender: { id: "user-one" },
    text: "hello again",
    mentionsBot: false,
    attachments: [],
    timestamp: Date.now(),
    providerContext: { contextToken: "context-two" },
  });
  const allSessionChanges = events.filter((event) => event.topic === "sessions.changed");
  assert.equal(allSessionChanges.length, 2, "every external turn must invalidate the bound desktop session");
  assert.equal(allSessionChanges[1].data.sessionId, "session-one");
  await manager.shutdown();
});

test("account tool changes update bindings and synchronize their existing sessions", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "pi-channel-manager-default-tools-"));
  const fake = createFakeAdapter("telegram");
  const registry = new AdapterRegistry();
  registry.register(fake.adapter);
  const bindingsSeen = [];
  const toolSyncs = [];
  const manager = new ChannelManager({ handle() {}, attachPort() {}, detachPort() {}, emit() {} }, () => {}, {
    dataDirectory: dir,
    registry,
    secretAccess: {
      get: async () => ({ token: "token", providerAccountId: "bot", baseUrl: "https://example.test" }),
      set: async () => {},
      delete: async () => {},
    },
    bridge: {
      async syncTools(binding, toolNames) {
        toolSyncs.push({ peerId: binding.peerId, sessionId: binding.sessionId, toolNames: [...toolNames] });
      },
      async runTurn(binding, _envelope, _onProgress, _attachments, newSessionToolNames) {
        bindingsSeen.push({
          peerId: binding.peerId,
          bindingToolNames: [...binding.toolNames],
          newSessionToolNames: [...newSessionToolNames],
        });
        return {
          sessionId: binding.sessionId ?? `session-${binding.peerId}`,
          cwd: binding.cwd,
          finalText: "ok",
          generatedFiles: [],
        };
      },
    },
  });
  const now = new Date().toISOString();
  const account = {
    id: "telegram-default-tools",
    channel: "telegram",
    name: "Default tools bot",
    enabled: true,
    providerAccountId: "bot",
    dmPolicy: "open",
    allowFrom: [],
    groupPolicy: "disabled",
    groupIds: [],
    groupAllowFrom: [],
    requireMention: true,
    toolNames: [],
    createdAt: now,
    updatedAt: now,
  };
  const envelope = (id, peerId) => ({
    id,
    channel: "telegram",
    accountId: account.id,
    peer: { kind: "dm", id: peerId },
    sender: { id: peerId },
    text: "test",
    mentionsBot: false,
    attachments: [],
    timestamp: Date.now(),
  });

  await manager.upsertAccount(account);
  await fake.emit(envelope("before-update", "user-one"));

  const fullTools = ["read", "bash", "edit", "write", "grep", "find", "ls"];
  await manager.upsertAccount({ ...account, toolNames: fullTools });
  await fake.emit(envelope("existing-after-update", "user-one"));
  await fake.emit(envelope("new-after-update", "user-two"));

  assert.deepEqual(bindingsSeen, [
    { peerId: "user-one", bindingToolNames: [], newSessionToolNames: [] },
    { peerId: "user-one", bindingToolNames: fullTools, newSessionToolNames: fullTools },
    { peerId: "user-two", bindingToolNames: fullTools, newSessionToolNames: fullTools },
  ]);
  assert.deepEqual(toolSyncs, [{ peerId: "user-one", sessionId: "session-user-one", toolNames: fullTools }]);
  const snapshot = await manager.snapshot();
  assert.deepEqual(snapshot.accounts[0].toolNames, fullTools);
  assert.deepEqual(
    snapshot.bindings.map((binding) => [binding.peerId, binding.toolNames]),
    [
      ["user-one", fullTools],
      ["user-two", fullTools],
    ],
  );
  await manager.shutdown();
});

test("accepted media is staged privately and passed to the existing Pi turn", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "pi-channel-manager-media-"));
  const fake = createFakeAdapter("telegram");
  const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3]);
  fake.adapter.downloadInbound = async () => [
    { kind: "image", data: png, name: "../../photo.png", mime: "image/jpeg" },
  ];
  const registry = new AdapterRegistry();
  registry.register(fake.adapter);
  let staged;
  let generatedPath;
  const manager = new ChannelManager({ handle() {}, attachPort() {}, detachPort() {}, emit() {} }, () => {}, {
    dataDirectory: dir,
    registry,
    secretAccess: {
      get: async () => ({ token: "token", providerAccountId: "42", baseUrl: "https://telegram.example" }),
      set: async () => {},
      delete: async () => {},
    },
    bridge: {
      async runTurn(binding, _envelope, _onProgress, attachments) {
        staged = attachments;
        await mkdir(binding.cwd, { recursive: true });
        generatedPath = path.join(binding.cwd, "result.txt");
        await writeFile(generatedPath, "generated");
        return { sessionId: "session-media", finalText: "I can see it", generatedFiles: [generatedPath] };
      },
    },
  });
  const now = new Date().toISOString();
  await manager.upsertAccount({
    id: "telegram-media",
    channel: "telegram",
    name: "Telegram",
    enabled: true,
    dmPolicy: "open",
    allowFrom: [],
    groupPolicy: "disabled",
    groupIds: [],
    groupAllowFrom: [],
    requireMention: true,
    toolNames: [],
    defaultCwd: path.join(dir, "workspace"),
    createdAt: now,
    updatedAt: now,
  });
  await fake.emit({
    id: "media-one",
    channel: "telegram",
    accountId: "telegram-media",
    peer: { kind: "dm", id: "7" },
    sender: { id: "7" },
    text: "",
    mentionsBot: false,
    attachments: [{ kind: "image", name: "../../photo.png", mime: "image/jpeg" }],
    timestamp: Date.now(),
  });
  assert.equal(staged.length, 1);
  assert.equal(staged[0].name, "photo.png");
  assert.equal(staged[0].mime, "image/png");
  assert.deepEqual(await readFile(staged[0].path), png);
  assert.match(staged[0].path, /channel-media/);
  assert.equal(fake.sent[0].text, "I can see it");
  assert.equal(fake.sent[1].text, "");
  assert.deepEqual(fake.sent[1].attachments, [
    { kind: "file", path: generatedPath, name: "result.txt", mime: "text/plain" },
  ]);
  await manager.shutdown();
});

test("Feishu generated files use the shared outbound capability and preserve the source reply route", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "pi-channel-manager-feishu-media-"));
  const fake = createFakeAdapter("feishu");
  const registry = new AdapterRegistry();
  registry.register(fake.adapter);
  let generatedPath;
  const manager = new ChannelManager({ handle() {}, attachPort() {}, detachPort() {}, emit() {} }, () => {}, {
    dataDirectory: dir,
    registry,
    secretAccess: {
      get: async () => ({ token: "secret", providerAccountId: "ou_bot", baseUrl: "https://open.feishu.cn" }),
      set: async () => {},
      delete: async () => {},
    },
    bridge: {
      async runTurn(binding) {
        await mkdir(binding.cwd, { recursive: true });
        generatedPath = path.join(binding.cwd, "report.pdf");
        await writeFile(generatedPath, "pdf-fixture");
        return { sessionId: "session-feishu-media", finalText: "报告如下", generatedFiles: [generatedPath] };
      },
    },
  });
  const now = new Date().toISOString();
  await manager.upsertAccount({
    id: "feishu-media",
    channel: "feishu",
    name: "Feishu",
    enabled: true,
    appId: "cli_1234567890abcdef",
    domain: "feishu",
    dmPolicy: "open",
    allowFrom: [],
    groupPolicy: "disabled",
    groupIds: [],
    groupAllowFrom: [],
    requireMention: true,
    toolNames: [],
    defaultCwd: path.join(dir, "workspace"),
    createdAt: now,
    updatedAt: now,
  });
  await fake.emit({
    id: "om_feishu_media",
    channel: "feishu",
    accountId: "feishu-media",
    peer: { kind: "dm", id: "ou_user" },
    sender: { id: "ou_user" },
    text: "把报告发给我",
    mentionsBot: false,
    attachments: [],
    timestamp: Date.now(),
    providerContext: { replyToMessageId: "om_source" },
  });
  assert.equal(fake.sent[0].text, "报告如下");
  assert.equal(fake.sent[1].text, "");
  assert.equal(fake.sent[1].replyToMessageId, "om_source");
  assert.deepEqual(fake.sent[1].attachments, [
    { kind: "file", path: generatedPath, name: "report.pdf", mime: "application/pdf" },
  ]);
  await manager.shutdown();
});

test("progressive adapters receive Agent events and own the final delivery", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "pi-channel-progressive-"));
  const fake = createFakeAdapter("telegram");
  const progress = [];
  const finals = [];
  let turnContext;
  fake.adapter.beginTurn = (context) => {
    turnContext = context;
    return {
      update: (event) => progress.push(event),
      async finish(text) {
        finals.push(text);
        return {
          id: "progressive-receipt",
          channel: "telegram",
          accountId: context.account.id,
          peerId: context.peerId,
          messageId: "rich-final",
          deliveredAt: new Date().toISOString(),
        };
      },
      async cancel() {},
    };
  };
  const registry = new AdapterRegistry();
  registry.register(fake.adapter);
  const manager = new ChannelManager({ handle() {}, attachPort() {}, detachPort() {}, emit() {} }, () => {}, {
    dataDirectory: dir,
    registry,
    secretAccess: {
      get: async () => ({ token: "token", providerAccountId: "42", baseUrl: "https://telegram.example" }),
      set: async () => {},
      delete: async () => {},
    },
    bridge: {
      async runTurn(_binding, _envelope, onProgress) {
        onProgress({
          type: "message",
          phase: "update",
          message: { role: "assistant", content: [{ type: "text", text: "partial" }] },
        });
        return { sessionId: "session-progressive", finalText: "rich final", generatedFiles: [] };
      },
    },
  });
  const now = new Date().toISOString();
  await manager.upsertAccount({
    id: "telegram-progressive",
    channel: "telegram",
    name: "@pi_bot",
    enabled: true,
    providerAccountId: "42",
    dmPolicy: "open",
    allowFrom: [],
    groupPolicy: "disabled",
    groupIds: [],
    groupAllowFrom: [],
    requireMention: true,
    toolNames: [],
    createdAt: now,
    updatedAt: now,
  });

  await fake.emit({
    id: "progressive-one",
    channel: "telegram",
    accountId: "telegram-progressive",
    peer: { kind: "dm", id: "7" },
    sender: { id: "7" },
    text: "hello",
    mentionsBot: false,
    attachments: [],
    timestamp: Date.now(),
    providerContext: { replyToMessageId: "15" },
  });

  assert.equal(turnContext.peerKind, "dm");
  assert.equal(turnContext.replyToMessageId, "15");
  assert.deepEqual(
    progress.map((event) => event.type),
    ["message"],
  );
  assert.deepEqual(finals, ["rich final"]);
  assert.equal(fake.sent.length, 0, "final delivery must not be duplicated through adapter.send");
  await manager.shutdown();
});

test("unknown sender receives pairing code without invoking Pi", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "pi-channel-pairing-"));
  const fake = createFakeAdapter();
  const registry = new AdapterRegistry();
  registry.register(fake.adapter);
  let bridgeCalls = 0;
  let mediaDownloads = 0;
  fake.adapter.downloadInbound = async () => {
    mediaDownloads += 1;
    return [];
  };
  const manager = new ChannelManager({ handle() {}, attachPort() {}, detachPort() {}, emit() {} }, () => {}, {
    dataDirectory: dir,
    registry,
    secretAccess: {
      get: async () => ({ token: "token", providerAccountId: "raw", baseUrl: "https://example.test" }),
      set: async () => {},
      delete: async () => {},
    },
    bridge: {
      async runTurn() {
        bridgeCalls += 1;
        throw new Error("must not run");
      },
    },
  });
  const now = new Date().toISOString();
  await manager.upsertAccount({
    id: "wx-two",
    channel: "weixin",
    name: "Weixin",
    enabled: true,
    dmPolicy: "pairing",
    allowFrom: [],
    groupPolicy: "disabled",
    groupIds: [],
    groupAllowFrom: [],
    requireMention: true,
    toolNames: [],
    createdAt: now,
    updatedAt: now,
  });
  await fake.emit({
    id: "event-two",
    channel: "weixin",
    accountId: "wx-two",
    peer: { kind: "dm", id: "stranger" },
    sender: { id: "stranger" },
    text: "",
    mentionsBot: false,
    attachments: [{ kind: "image", mime: "image/jpeg" }],
    timestamp: Date.now(),
    providerContext: { contextToken: "ctx" },
  });
  assert.equal(bridgeCalls, 0);
  assert.equal(mediaDownloads, 0, "pairing policy must run before any provider media download");
  assert.match(fake.sent[0].text, /配对码：\d{6}/);
  assert.equal((await manager.snapshot()).pairings.length, 1);
  await manager.shutdown();
});

test("opt-in IM commands execute locally while unknown and disabled commands remain Agent prompts", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "pi-channel-commands-"));
  const fake = createFakeAdapter();
  const registry = new AdapterRegistry();
  registry.register(fake.adapter);
  const events = [];
  const bridgeCalls = [];
  const commandCalls = [];
  const manager = new ChannelManager(
    {
      handle() {},
      attachPort() {},
      detachPort() {},
      emit(topic, key, data) {
        events.push({ topic, key, data });
      },
    },
    () => {},
    {
      dataDirectory: dir,
      registry,
      secretAccess: {
        get: async () => ({ token: "token", providerAccountId: "raw", baseUrl: "https://example.test" }),
        set: async () => {},
        delete: async () => {},
      },
      bridge: {
        getSessionStatus(binding) {
          return { hasSession: Boolean(binding.sessionId), running: false };
        },
        async newSession(_binding, toolNames) {
          commandCalls.push({ command: "new", toolNames: [...toolNames] });
          return { sessionId: "session-command" };
        },
        async runCommand(_binding, command, customInstructions) {
          commandCalls.push({ command, customInstructions });
          return { sessionId: "session-command" };
        },
        async runTurn(_binding, envelope) {
          bridgeCalls.push(envelope.text);
          return { sessionId: "session-command", finalText: `agent:${envelope.text}`, generatedFiles: [] };
        },
      },
    },
  );
  const now = new Date().toISOString();
  const fullTools = ["read", "bash", "edit", "write", "grep", "find", "ls"];
  const account = {
    id: "wx-commands",
    channel: "weixin",
    name: "Weixin commands",
    enabled: true,
    dmPolicy: "allowlist",
    allowFrom: ["user-one"],
    groupPolicy: "disabled",
    groupIds: [],
    groupAllowFrom: [],
    requireMention: true,
    commandsEnabled: true,
    defaultCwd: path.join(dir, "workspace"),
    toolNames: fullTools,
    createdAt: now,
    updatedAt: now,
  };
  await manager.upsertAccount(account);
  let eventId = 0;
  const send = (text) =>
    fake.emit({
      id: `command-${++eventId}`,
      channel: "weixin",
      accountId: account.id,
      peer: { kind: "dm", id: "user-one" },
      sender: { id: "user-one" },
      text,
      mentionsBot: false,
      attachments: [],
      timestamp: Date.now(),
      providerContext: { contextToken: "ctx" },
    });

  await send("/help");
  assert.match(fake.sent.at(-1).text, /\/compact \[说明\]/);
  await send("/status");
  assert.match(fake.sent.at(-1).text, /IM 命令：已启用/);
  await send("/new");
  assert.match(fake.sent.at(-1).text, /新的独立会话/);
  await send("/compact keep decisions");
  await send("/reload");
  assert.deepEqual(commandCalls, [
    { command: "new", toolNames: fullTools },
    { command: "compact", customInstructions: "keep decisions" },
    { command: "reload", customInstructions: undefined },
  ]);
  await send("/unknown");
  assert.deepEqual(bridgeCalls, ["/unknown"]);
  assert.equal(fake.sent.at(-1).text, "agent:/unknown");

  await manager.upsertAccount({ ...account, commandsEnabled: false });
  await send("/help");
  assert.deepEqual(bridgeCalls, ["/unknown", "/help"]);
  assert.equal(fake.sent.at(-1).text, "agent:/help");
  assert.equal(
    events.filter((event) => event.topic === "sessions.changed").length,
    5,
    "new, compact, reload, unknown, and disabled-command Agent turns should invalidate the bound session",
  );
  await manager.shutdown();
});

test("account connect probes before persisting and cleans up a rejected credential", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "pi-channel-connect-"));
  const fake = createFakeAdapter("telegram");
  fake.adapter.probe = async (account, secret) =>
    secret.token === "bad-token"
      ? { ok: false, message: "invalid token", accountId: account.id }
      : {
          ok: true,
          message: "ok",
          accountId: account.id,
          providerAccountId: "42",
          providerUsername: "@pi_bot",
          displayName: "Pi @pi_bot",
        };
  const registry = new AdapterRegistry();
  registry.register(fake.adapter);
  const secrets = new Map([
    ["telegram-good", { token: "good-token", providerAccountId: "temporary", baseUrl: "https://telegram.example" }],
    ["telegram-bad", { token: "bad-token", providerAccountId: "temporary", baseUrl: "https://telegram.example" }],
  ]);
  const manager = new ChannelManager({ handle() {}, attachPort() {}, detachPort() {}, emit() {} }, () => {}, {
    dataDirectory: dir,
    registry,
    secretAccess: {
      get: async (_channel, id) => secrets.get(id) ?? null,
      set: async (_channel, id, secret) => secrets.set(id, secret),
      delete: async (_channel, id) => secrets.delete(id),
    },
    bridge: {
      async runTurn() {
        throw new Error("not used");
      },
    },
  });
  const now = new Date().toISOString();
  const account = (id) => ({
    id,
    channel: "telegram",
    name: "",
    enabled: false,
    dmPolicy: "pairing",
    allowFrom: [],
    groupPolicy: "disabled",
    groupIds: [],
    groupAllowFrom: [],
    requireMention: true,
    toolNames: [],
    createdAt: now,
    updatedAt: now,
  });

  const connected = await manager.connectAccount(account("telegram-good"));
  assert.equal(connected.accounts[0].name, "@pi_bot");
  assert.equal(connected.accounts[0].providerAccountId, "42");
  assert.equal(connected.accounts[0].configured, true);
  assert.equal(secrets.get("telegram-good").providerAccountId, "42");

  await assert.rejects(manager.connectAccount(account("telegram-bad")), /invalid token/);
  assert.equal(
    (await manager.snapshot()).accounts.some((item) => item.id === "telegram-bad"),
    false,
  );
  assert.equal(secrets.has("telegram-bad"), false);
  await manager.shutdown();
});

test("Feishu scan login persists credentials, probes the bot, and enforces owner-only defaults", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "pi-channel-feishu-scan-"));
  const fake = createFakeAdapter("feishu");
  const runtimeStarts = [];
  fake.adapter.start = async (context) => {
    runtimeStarts.push({ account: structuredClone(context.account), secret: structuredClone(context.secret) });
    context.onStatus({ state: "running", connected: true });
    await new Promise((resolve) => context.signal.addEventListener("abort", resolve, { once: true }));
  };
  const appId = "cli_1234567890abcdef";
  const accountId = scanAccountId("feishu", appId);
  let startOptions;
  fake.adapter.startLogin = async (options) => {
    startOptions = options;
    return {
      channel: "feishu",
      sessionKey: "scan-session",
      phase: "qr",
      message: "scan",
      qrContent: "https://accounts.feishu.cn/qr",
    };
  };
  let pollCalls = 0;
  fake.adapter.pollLogin = async () => {
    pollCalls += 1;
    return {
      event: {
        channel: "feishu",
        sessionKey: "scan-session",
        phase: "confirmed",
        message: "created",
        accountId,
      },
      credential: {
        token: "app-secret-must-stay-host-side",
        providerAccountId: appId,
        baseUrl: "https://open.feishu.cn",
      },
      account: { appId, domain: "feishu", ownerUserId: "ou_owner" },
    };
  };
  fake.adapter.probe = async (account) => ({
    ok: true,
    accountId: account.id,
    providerAccountId: "ou_bot",
    displayName: "Pi Bot",
    message: "ok",
  });
  const registry = new AdapterRegistry();
  registry.register(fake.adapter);
  const secrets = new Map();
  const emitted = [];
  const manager = new ChannelManager(
    {
      handle() {},
      attachPort() {},
      detachPort() {},
      emit(topic, key, data) {
        emitted.push({ topic, key, data });
      },
    },
    () => {},
    {
      dataDirectory: dir,
      registry,
      secretAccess: {
        get: async (_channel, id) => secrets.get(id) ?? null,
        set: async (_channel, id, secret) => secrets.set(id, structuredClone(secret)),
        delete: async (_channel, id) => secrets.delete(id),
      },
      bridge: {
        async runTurn() {
          throw new Error("not used");
        },
      },
    },
  );

  const started = await manager.startLogin({ channel: "feishu", domain: "feishu", force: true });
  assert.equal(started.phase, "qr");
  assert.deepEqual(startOptions, { channel: "feishu", domain: "feishu", force: true, localTokens: [] });
  const [completed, concurrent] = await Promise.all([
    manager.waitLogin("feishu", "scan-session"),
    manager.waitLogin("feishu", "scan-session"),
  ]);
  assert.equal(completed.phase, "confirmed");
  assert.equal(completed.message, "飞书/Lark 机器人已创建并连接。");
  assert.deepEqual(concurrent, completed);
  const repeated = await manager.waitLogin("feishu", "scan-session");
  assert.equal(repeated.phase, "confirmed");
  assert.equal(pollCalls, 1);

  const snapshot = await manager.snapshot();
  assert.equal(snapshot.accounts.length, 1);
  const account = snapshot.accounts.find((item) => item.id === accountId);
  assert.equal(account.appId, appId);
  assert.equal(account.domain, "feishu");
  assert.equal(account.providerAccountId, "ou_bot");
  assert.equal(account.name, "Pi Bot");
  assert.equal(account.dmPolicy, "allowlist");
  assert.deepEqual(account.allowFrom, ["ou_owner"]);
  assert.equal(account.groupPolicy, "disabled");
  assert.equal(account.commandsEnabled, false);
  assert.deepEqual(account.toolNames, []);
  assert.equal(account.configured, true);
  assert.deepEqual(secrets.get(accountId), {
    token: "app-secret-must-stay-host-side",
    providerAccountId: "ou_bot",
    baseUrl: "https://open.feishu.cn",
  });
  assert.doesNotMatch(JSON.stringify(emitted), /app-secret-must-stay-host-side/);
  assert.equal(runtimeStarts.length, 1);
  await manager.shutdown();

  const restoredManager = new ChannelManager(
    {
      handle() {},
      attachPort() {},
      detachPort() {},
      emit(topic, key, data) {
        emitted.push({ topic, key, data });
      },
    },
    () => {},
    {
      dataDirectory: dir,
      registry,
      secretAccess: {
        get: async (_channel, id) => secrets.get(id) ?? null,
        set: async (_channel, id, secret) => secrets.set(id, structuredClone(secret)),
        delete: async (_channel, id) => secrets.delete(id),
      },
      bridge: {
        async runTurn() {
          throw new Error("not used");
        },
      },
    },
  );
  await restoredManager.initialize();
  assert.equal(runtimeStarts.length, 2);
  assert.equal(runtimeStarts[1].account.id, accountId);
  assert.equal(runtimeStarts[1].account.appId, appId);
  assert.equal(runtimeStarts[1].secret.token, "app-secret-must-stay-host-side");
  assert.equal((await restoredManager.snapshot()).statuses[0].state, "running");
  assert.doesNotMatch(JSON.stringify(emitted), /app-secret-must-stay-host-side/);
  await restoredManager.shutdown();
});

test("Feishu scan login falls back to pairing when the provider omits the scanner open_id", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "pi-channel-feishu-scan-pairing-"));
  const fake = createFakeAdapter("feishu");
  const appId = "cli_withoutowner123";
  const accountId = scanAccountId("lark", appId);
  fake.adapter.pollLogin = async () => ({
    event: { channel: "feishu", sessionKey: "lark-scan", phase: "confirmed", message: "created", accountId },
    credential: { token: "secret", providerAccountId: appId, baseUrl: "https://open.larksuite.com" },
    account: { appId, domain: "lark" },
  });
  const registry = new AdapterRegistry();
  registry.register(fake.adapter);
  const secrets = new Map();
  const manager = new ChannelManager({ handle() {}, attachPort() {}, detachPort() {}, emit() {} }, () => {}, {
    dataDirectory: dir,
    registry,
    secretAccess: {
      get: async (_channel, id) => secrets.get(id) ?? null,
      set: async (_channel, id, secret) => secrets.set(id, secret),
      delete: async (_channel, id) => secrets.delete(id),
    },
    bridge: {
      async runTurn() {
        throw new Error("not used");
      },
    },
  });
  await manager.waitLogin("feishu", "lark-scan");
  const account = (await manager.snapshot()).accounts[0];
  assert.equal(account.dmPolicy, "pairing");
  assert.deepEqual(account.allowFrom, []);
  await manager.shutdown();
});

test("Feishu scan login rolls back a newly written secret when config persistence fails", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "pi-channel-feishu-scan-rollback-"));
  const blockedDataDirectory = path.join(dir, "not-a-directory");
  await writeFile(blockedDataDirectory, "blocked");
  const fake = createFakeAdapter("feishu");
  const appId = "cli_rollback123456";
  const accountId = scanAccountId("feishu", appId);
  fake.adapter.pollLogin = async () => ({
    event: { channel: "feishu", sessionKey: "rollback", phase: "confirmed", message: "created", accountId },
    credential: { token: "must-be-deleted", providerAccountId: appId, baseUrl: "https://open.feishu.cn" },
    account: { appId, domain: "feishu", ownerUserId: "ou_owner" },
  });
  const registry = new AdapterRegistry();
  registry.register(fake.adapter);
  const secrets = new Map();
  const manager = new ChannelManager({ handle() {}, attachPort() {}, detachPort() {}, emit() {} }, () => {}, {
    dataDirectory: blockedDataDirectory,
    registry,
    secretAccess: {
      get: async (_channel, id) => secrets.get(id) ?? null,
      set: async (_channel, id, secret) => secrets.set(id, secret),
      delete: async (_channel, id) => secrets.delete(id),
    },
    bridge: {
      async runTurn() {
        throw new Error("not used");
      },
    },
  });
  const event = await manager.waitLogin("feishu", "rollback");
  assert.equal(event.phase, "error");
  assert.match(event.message, /安全保存失败/);
  assert.equal(secrets.has(accountId), false);
});

test("Feishu scan login does not create an account when the encrypted vault rejects the secret", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "pi-channel-feishu-scan-vault-failure-"));
  const fake = createFakeAdapter("feishu");
  const appId = "cli_vaultfailure123";
  const accountId = scanAccountId("feishu", appId);
  fake.adapter.pollLogin = async () => ({
    event: { channel: "feishu", sessionKey: "vault-failure", phase: "confirmed", message: "created", accountId },
    credential: { token: "never-persisted", providerAccountId: appId, baseUrl: "https://open.feishu.cn" },
    account: { appId, domain: "feishu", ownerUserId: "ou_owner" },
  });
  const registry = new AdapterRegistry();
  registry.register(fake.adapter);
  const manager = new ChannelManager({ handle() {}, attachPort() {}, detachPort() {}, emit() {} }, () => {}, {
    dataDirectory: dir,
    registry,
    secretAccess: {
      get: async () => null,
      set: async () => {
        throw new Error("safeStorage unavailable");
      },
      delete: async () => {},
    },
    bridge: {
      async runTurn() {
        throw new Error("not used");
      },
    },
  });
  const event = await manager.waitLogin("feishu", "vault-failure");
  assert.equal(event.phase, "error");
  assert.match(event.message, /安全保存失败/);
  assert.equal((await manager.snapshot()).accounts.length, 0);
  await manager.shutdown();
});

test("Feishu scan login retains encrypted credentials for retry when the bot probe fails", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "pi-channel-feishu-scan-probe-failure-"));
  const fake = createFakeAdapter("feishu");
  const appId = "cli_probefailure123";
  const accountId = scanAccountId("feishu", appId);
  fake.adapter.pollLogin = async () => ({
    event: { channel: "feishu", sessionKey: "probe-failure", phase: "confirmed", message: "created", accountId },
    credential: { token: "retained-secret", providerAccountId: appId, baseUrl: "https://open.feishu.cn" },
    account: { appId, domain: "feishu", ownerUserId: "ou_owner" },
  });
  fake.adapter.probe = async (account) => ({
    ok: false,
    accountId: account.id,
    message: "机器人权限尚未生效 retained-secret",
  });
  const registry = new AdapterRegistry();
  registry.register(fake.adapter);
  const secrets = new Map();
  const manager = new ChannelManager({ handle() {}, attachPort() {}, detachPort() {}, emit() {} }, () => {}, {
    dataDirectory: dir,
    registry,
    secretAccess: {
      get: async (_channel, id) => secrets.get(id) ?? null,
      set: async (_channel, id, secret) => secrets.set(id, secret),
      delete: async (_channel, id) => secrets.delete(id),
    },
    bridge: {
      async runTurn() {
        throw new Error("not used");
      },
    },
  });
  await manager.snapshot();
  const event = await manager.waitLogin("feishu", "probe-failure");
  assert.equal(event.phase, "error");
  assert.equal(event.accountId, accountId);
  assert.match(event.message, /机器人权限尚未生效/);
  assert.doesNotMatch(event.message, /retained-secret/);
  const snapshot = await manager.snapshot();
  assert.equal(snapshot.accounts[0].configured, true);
  assert.equal(snapshot.accounts[0].dmPolicy, "allowlist");
  assert.equal(secrets.get(accountId).token, "retained-secret");
  await manager.shutdown();
});

test("Telegram DMs and forum topics resolve to isolated sessions and reply routes", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "pi-channel-telegram-routes-"));
  const fake = createFakeAdapter("telegram");
  const registry = new AdapterRegistry();
  registry.register(fake.adapter);
  const bindingsSeen = [];
  const manager = new ChannelManager({ handle() {}, attachPort() {}, detachPort() {}, emit() {} }, () => {}, {
    dataDirectory: dir,
    registry,
    secretAccess: {
      get: async () => ({ token: "token", providerAccountId: "42", baseUrl: "https://telegram.example" }),
      set: async () => {},
      delete: async () => {},
    },
    bridge: {
      async runTurn(binding) {
        bindingsSeen.push(binding);
        return {
          sessionId: `session-${binding.id}`,
          finalText: `reply-${binding.threadId ?? binding.peerId}`,
          generatedFiles: [],
        };
      },
    },
  });
  const now = new Date().toISOString();
  await manager.upsertAccount({
    id: "telegram-one",
    channel: "telegram",
    name: "@pi_bot",
    enabled: true,
    providerAccountId: "42",
    providerUsername: "@pi_bot",
    baseUrl: "https://telegram.example",
    dmPolicy: "open",
    allowFrom: [],
    groupPolicy: "open",
    groupIds: [],
    groupAllowFrom: [],
    requireMention: true,
    toolNames: [],
    createdAt: now,
    updatedAt: now,
  });

  const envelope = (id, peer, sender, threadId) => ({
    id,
    channel: "telegram",
    accountId: "telegram-one",
    peer,
    ...(threadId ? { threadId } : {}),
    sender: { id: sender },
    text: `message-${id}`,
    mentionsBot: peer.kind === "group",
    attachments: [],
    timestamp: Date.now(),
    providerContext: { replyToMessageId: id },
  });

  await fake.emit(envelope("dm-1", { kind: "dm", id: "101" }, "101"));
  await fake.emit(envelope("dm-2", { kind: "dm", id: "202" }, "202"));
  await fake.emit(envelope("topic-10", { kind: "group", id: "-1001" }, "303", "10"));
  await fake.emit(envelope("topic-11", { kind: "group", id: "-1001" }, "303", "11"));

  const snapshot = await manager.snapshot();
  assert.equal(snapshot.bindings.length, 4);
  assert.equal(new Set(snapshot.bindings.map((binding) => binding.sessionId)).size, 4);
  assert.equal(new Set(bindingsSeen.map((binding) => binding.id)).size, 4);
  assert.deepEqual(
    fake.sent.slice(-2).map((send) => [send.peerId, send.threadId, send.replyToMessageId]),
    [
      ["-1001", "10", "topic-10"],
      ["-1001", "11", "topic-11"],
    ],
  );
  await manager.shutdown();
});

test("Feishu and Lark accounts isolate the same open_id and hot-reload account changes", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "pi-channel-feishu-routes-"));
  const inboundByAccount = new Map();
  const starts = new Map();
  const aborts = new Map();
  const sent = [];
  const adapter = {
    id: "feishu",
    async start(context) {
      const id = context.account.id;
      starts.set(id, (starts.get(id) ?? 0) + 1);
      inboundByAccount.set(id, context.onInbound);
      context.onStatus({ state: "running", connected: true });
      await new Promise((resolve) => context.signal.addEventListener("abort", resolve, { once: true }));
      aborts.set(id, (aborts.get(id) ?? 0) + 1);
    },
    async send(context) {
      sent.push(context);
      return {
        id: `receipt-${sent.length}`,
        channel: "feishu",
        accountId: context.account.id,
        peerId: context.peerId,
        messageId: `om-${sent.length}`,
        deliveredAt: new Date().toISOString(),
      };
    },
    async probe(account) {
      return { ok: true, message: "ok", accountId: account.id, providerAccountId: account.providerAccountId };
    },
  };
  const registry = new AdapterRegistry();
  registry.register(adapter);
  const bindingsSeen = [];
  const manager = new ChannelManager({ handle() {}, attachPort() {}, detachPort() {}, emit() {} }, () => {}, {
    dataDirectory: dir,
    registry,
    secretAccess: {
      get: async (_channel, id) => ({
        token: `secret-${id}`,
        providerAccountId: id === "feishu-cn" ? "ou_bot_cn" : "ou_bot_lark",
        baseUrl: id === "feishu-cn" ? "https://open.feishu.cn" : "https://open.larksuite.com",
      }),
      set: async () => {},
      delete: async () => {},
    },
    bridge: {
      async runTurn(binding) {
        bindingsSeen.push(binding);
        return { sessionId: `session-${binding.id}`, finalText: "reply", generatedFiles: [] };
      },
    },
  });
  const now = new Date().toISOString();
  const makeAccount = (id, domain) => ({
    id,
    channel: "feishu",
    name: id,
    enabled: true,
    providerAccountId: id === "feishu-cn" ? "ou_bot_cn" : "ou_bot_lark",
    appId: id === "feishu-cn" ? "cli_1234567890abcdef" : "cli_fedcba0987654321",
    domain,
    dmPolicy: "open",
    allowFrom: [],
    groupPolicy: "disabled",
    groupIds: [],
    groupAllowFrom: [],
    requireMention: true,
    toolNames: [],
    createdAt: now,
    updatedAt: now,
  });

  const feishuAccount = makeAccount("feishu-cn", "feishu");
  const larkAccount = makeAccount("lark-global", "lark");
  await manager.upsertAccount(feishuAccount);
  await manager.upsertAccount(larkAccount);

  const emitDm = (accountId, id) =>
    inboundByAccount.get(accountId)({
      id,
      channel: "feishu",
      accountId,
      peer: { kind: "dm", id: "ou_same_user" },
      sender: { id: "ou_same_user" },
      text: "hello",
      mentionsBot: false,
      attachments: [],
      timestamp: Date.now(),
      providerContext: { replyToMessageId: id },
    });
  await emitDm("feishu-cn", "om-cn");
  await emitDm("lark-global", "om-lark");

  const snapshot = await manager.snapshot();
  assert.equal(snapshot.bindings.length, 2);
  assert.equal(new Set(snapshot.bindings.map((binding) => binding.id)).size, 2);
  assert.equal(new Set(snapshot.bindings.map((binding) => binding.sessionId)).size, 2);
  assert.equal(new Set(bindingsSeen.map((binding) => binding.accountId)).size, 2);

  await manager.upsertAccount({ ...feishuAccount, name: "Rotated Feishu Bot" });
  assert.equal(starts.get("feishu-cn"), 2);
  assert.equal(aborts.get("feishu-cn"), 1);
  assert.equal((await manager.snapshot()).accounts.find((item) => item.id === "feishu-cn").name, "Rotated Feishu Bot");
  await manager.shutdown();
});
