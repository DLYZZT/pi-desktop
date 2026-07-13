import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";

const output = path.join(import.meta.dirname, "../../../.artifacts/test-modules", `channel-core-${process.pid}.mjs`);
mkdirSync(path.dirname(output), { recursive: true });
await build({
  stdin: {
    contents: [
      'export { ChannelConfigStore } from "./config-store.ts";',
      'export { ChannelStateStore } from "./state-store.ts";',
      'export { LaneScheduler } from "./lane-scheduler.ts";',
      'export { splitChannelText } from "./outbound-renderer.ts";',
      'export { evaluateInboundPolicy } from "./policy.ts";',
      'export { redactChannelValue, safeChannelError } from "./redaction.ts";',
    ].join("\n"),
    resolveDir: import.meta.dirname,
    sourcefile: "channel-core-test-entry.ts",
    loader: "ts",
  },
  outfile: output,
  bundle: true,
  format: "esm",
  platform: "node",
  packages: "external",
  logLevel: "silent",
});
const {
  ChannelConfigStore,
  ChannelStateStore,
  LaneScheduler,
  splitChannelText,
  evaluateInboundPolicy,
  redactChannelValue,
  safeChannelError,
} = await import(`${pathToFileURL(output).href}?v=${Date.now()}`);

function account(overrides = {}) {
  const now = new Date().toISOString();
  return {
    id: "wx-one",
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
    ...overrides,
  };
}

function envelope(overrides = {}) {
  return {
    id: "m1",
    channel: "weixin",
    accountId: "wx-one",
    peer: { kind: "dm", id: "user-one" },
    sender: { id: "user-one" },
    text: "hello",
    mentionsBot: false,
    attachments: [],
    timestamp: Date.now(),
    ...overrides,
  };
}

test("channel config persists normalized accounts and bindings", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "pi-channels-config-"));
  const file = path.join(dir, "channels.json");
  const store = new ChannelConfigStore(file);
  const saved = store.upsertAccount(account({ allowFrom: [" user ", "user"] }));
  assert.deepEqual(saved.allowFrom, ["user"]);
  const binding = store.upsertBinding({
    id: "binding",
    channel: "weixin",
    accountId: saved.id,
    peerKind: "dm",
    peerId: "user",
    cwd: path.join(dir, "workspace"),
    toolNames: [],
    createdAt: saved.createdAt,
    lastUsedAt: saved.createdAt,
  });
  assert.equal(binding.peerId, "user");

  const reopened = new ChannelConfigStore(file);
  assert.equal(reopened.listAccounts().length, 1);
  assert.equal(reopened.listBindings()[0].id, "binding");
  assert.equal(JSON.parse(readFileSync(file, "utf8")).version, 1);
});

test("versionless config migrates and corrupt config is quarantined", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "pi-channels-migrate-"));
  const file = path.join(dir, "channels.json");
  writeFileSync(file, JSON.stringify({ accounts: [account()], bindings: [] }));
  assert.equal(new ChannelConfigStore(file).listAccounts().length, 1);
  assert.equal(JSON.parse(readFileSync(file, "utf8")).version, 1);

  writeFileSync(file, "{not-json");
  assert.equal(new ChannelConfigStore(file).listAccounts().length, 0);
  assert.equal(
    readdirSync(dir).some((name) => name.startsWith("channels.json.corrupt-")),
    true,
  );
});

test("state checkpoints cursor, context, dedupe, pairing, and redacted activity", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "pi-channels-state-"));
  const file = path.join(dir, "state.json");
  const state = new ChannelStateStore(file);
  state.setCursor("wx-one", "cursor-1");
  state.setContextToken("wx-one", "user-one", "context-secret");
  state.markProcessed("wx-one", "event-one");
  const now = Date.now();
  state.upsertPairing({
    id: "pair-one",
    code: "123456",
    channel: "weixin",
    accountId: "wx-one",
    peerId: "user-one",
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + 60_000).toISOString(),
  });
  state.addActivity({
    id: "activity",
    channel: "weixin",
    accountId: "wx-one",
    direction: "system",
    outcome: "accepted",
    at: new Date().toISOString(),
  });

  const reopened = new ChannelStateStore(file);
  assert.equal(reopened.getCursor("wx-one"), "cursor-1");
  assert.equal(reopened.getContextToken("wx-one", "user-one"), "context-secret");
  assert.equal(reopened.isProcessed("wx-one", "event-one"), true);
  assert.equal(reopened.listPairings()[0].code, "123456");
  assert.equal(reopened.listActivities()[0].id, "activity");
});

test("policy defaults to pairing and keeps group authorization independent", () => {
  assert.equal(evaluateInboundPolicy(account(), envelope()), "pair");
  assert.equal(evaluateInboundPolicy(account({ allowFrom: ["user-one"] }), envelope()), "allow");
  assert.equal(evaluateInboundPolicy(account({ dmPolicy: "allowlist" }), envelope()), "ignore");
  assert.equal(
    evaluateInboundPolicy(
      account({ groupPolicy: "allowlist", groupAllowFrom: ["user-one"], requireMention: true }),
      envelope({ peer: { kind: "group", id: "group" }, mentionsBot: false }),
    ),
    "ignore",
  );
  assert.equal(
    evaluateInboundPolicy(
      account({ groupPolicy: "allowlist", groupAllowFrom: ["user-one"], requireMention: true }),
      envelope({ peer: { kind: "group", id: "group" }, mentionsBot: true }),
    ),
    "allow",
  );
});

test("lane scheduler serializes a route while allowing other routes to progress", async () => {
  const scheduler = new LaneScheduler();
  const order = [];
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const first = scheduler.run("same", async () => {
    order.push("first-start");
    await gate;
    order.push("first-end");
  });
  const second = scheduler.run("same", async () => order.push("second"));
  const other = scheduler.run("other", async () => order.push("other"));
  await other;
  assert.deepEqual(order, ["first-start", "other"]);
  release();
  await Promise.all([first, second]);
  assert.deepEqual(order, ["first-start", "other", "first-end", "second"]);
});

test("lane scheduler bounds concurrency across independent routes", async () => {
  const scheduler = new LaneScheduler(2);
  let active = 0;
  let peak = 0;
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const tasks = ["a", "b", "c", "d"].map((key) =>
    scheduler.run(key, async () => {
      active += 1;
      peak = Math.max(peak, active);
      await gate;
      active -= 1;
    }),
  );
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(peak, 2);
  release();
  await Promise.all(tasks);
  assert.equal(peak, 2);
});

test("channel redaction removes structured and inline credentials", () => {
  assert.deepEqual(redactChannelValue({ token: "abc", nested: { contextToken: "def", ok: 1 } }), {
    token: "[REDACTED]",
    nested: { contextToken: "[REDACTED]", ok: 1 },
  });
  assert.equal(safeChannelError(new Error("Authorization: Bearer abcdef")), "Authorization: Bearer [REDACTED]");
});

test("outbound text splitting preserves Unicode and readable boundaries", () => {
  const chunks = splitChannelText(`${"你".repeat(8)}\n\n${"🙂".repeat(8)}`, 10);
  assert.deepEqual(chunks, ["你".repeat(8), "🙂".repeat(8)]);
  assert.equal(chunks.join("").includes("�"), false);
});
