import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";

const output = path.join(import.meta.dirname, "../../../.artifacts/test-modules", `channel-manager-${process.pid}.mjs`);
mkdirSync(path.dirname(output), { recursive: true });
await build({
  stdin: {
    contents: [
      'export { AdapterRegistry } from "./adapter-registry.ts";',
      'export { ChannelManager } from "./channel-manager.ts";',
    ].join("\n"),
    resolveDir: import.meta.dirname,
    sourcefile: "channel-manager-test-entry.ts",
    loader: "ts",
  },
  outfile: output,
  bundle: true,
  format: "esm",
  platform: "node",
  packages: "external",
  logLevel: "silent",
});
const { AdapterRegistry, ChannelManager } = await import(`${pathToFileURL(output).href}?v=${Date.now()}`);

function createFakeAdapter() {
  let inbound;
  const sent = [];
  return {
    adapter: {
      id: "weixin",
      async start(context) {
        inbound = context.onInbound;
        context.onStatus({ state: "running", connected: true });
        await new Promise((resolve) => context.signal.addEventListener("abort", resolve, { once: true }));
      },
      async send(context) {
        sent.push(context);
        return {
          id: `receipt-${sent.length}`,
          channel: "weixin",
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
  };
}

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
      get: async (id) => secrets.get(id) ?? null,
      set: async (id, secret) => secrets.set(id, secret),
      delete: async (id) => secrets.delete(id),
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
  assert.equal(
    events.some((event) => event.topic === "sessions.changed"),
    true,
  );
  assert.equal(
    events.some(
      (event) =>
        event.topic === "channels.binding" &&
        event.data.action === "upsert" &&
        event.data.binding?.sessionId === "session-one",
    ),
    true,
  );
  await manager.shutdown();
});

test("unknown sender receives pairing code without invoking Pi", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "pi-channel-pairing-"));
  const fake = createFakeAdapter();
  const registry = new AdapterRegistry();
  registry.register(fake.adapter);
  let bridgeCalls = 0;
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
    text: "hello",
    mentionsBot: false,
    attachments: [],
    timestamp: Date.now(),
    providerContext: { contextToken: "ctx" },
  });
  assert.equal(bridgeCalls, 0);
  assert.match(fake.sent[0].text, /配对码：\d{6}/);
  assert.equal((await manager.snapshot()).pairings.length, 1);
  await manager.shutdown();
});
