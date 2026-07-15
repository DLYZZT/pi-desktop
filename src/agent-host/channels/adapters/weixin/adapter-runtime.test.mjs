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
  `weixin-adapter-runtime-${process.pid}.mjs`,
);
mkdirSync(path.dirname(output), { recursive: true });
await build({
  stdin: {
    contents: [
      'export { WeixinAdapter } from "./adapter.ts";',
      'export { ChannelStateStore } from "../../state-store.ts";',
    ].join("\n"),
    resolveDir: import.meta.dirname,
    sourcefile: "weixin-adapter-runtime-test-entry.ts",
    loader: "ts",
  },
  outfile: output,
  bundle: true,
  format: "esm",
  platform: "node",
  packages: "external",
  logLevel: "silent",
});

const { ChannelStateStore, WeixinAdapter } = await import(`${pathToFileURL(output).href}?v=${Date.now()}`);

function jsonResponse(value = {}) {
  return {
    ok: true,
    status: 200,
    text: async () => JSON.stringify(value),
  };
}

function account() {
  const now = new Date().toISOString();
  return {
    id: "wx-runtime",
    channel: "weixin",
    name: "Runtime test",
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
  };
}

function stateStore() {
  const dir = mkdtempSync(path.join(tmpdir(), "pi-weixin-runtime-"));
  return new ChannelStateStore(path.join(dir, "state.json"));
}

test("runtime checkpoints cursor and suppresses duplicate inbound events", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  globalThis.fetch = async (url) => {
    const endpoint = String(url);
    if (endpoint.includes("getupdates")) {
      const message = {
        message_id: 101,
        message_type: 1,
        from_user_id: "user-one",
        context_token: "context-one",
        item_list: [{ type: 1, text_item: { text: "hello" } }],
      };
      return jsonResponse({ ret: 0, msgs: [message, message], get_updates_buf: "cursor-next" });
    }
    return jsonResponse();
  };

  const controller = new globalThis.AbortController();
  const state = stateStore();
  const inbound = [];
  await new WeixinAdapter().start({
    account: account(),
    secret: { token: "secret", providerAccountId: "provider", baseUrl: "https://example.test" },
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
  assert.equal(inbound[0].text, "hello");
  assert.equal(state.getCursor("wx-runtime"), "cursor-next");
  assert.equal(state.getContextToken("wx-runtime", "user-one"), "context-one");
  assert.equal(state.isProcessed("wx-runtime", "101"), true);
});

test("runtime downloads Weixin media only through the private adapter capability", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  const controller = new globalThis.AbortController();
  const configuredAccount = account();
  const secret = { token: "secret", providerAccountId: "provider", baseUrl: "https://example.test" };
  const adapter = new WeixinAdapter();
  let downloaded;
  globalThis.fetch = async (url) => {
    const endpoint = String(url);
    if (endpoint.includes("getupdates")) {
      return jsonResponse({
        ret: 0,
        msgs: [
          {
            message_id: 303,
            message_type: 1,
            from_user_id: "user-media",
            item_list: [
              {
                type: 2,
                image_item: { media: { full_url: "https://novac2c.cdn.weixin.qq.com/c2c/image" } },
              },
            ],
          },
        ],
        get_updates_buf: "cursor-media",
      });
    }
    if (endpoint.includes("novac2c.cdn.weixin.qq.com")) {
      return new globalThis.Response(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1]), { status: 200 });
    }
    return jsonResponse();
  };
  await adapter.start({
    account: configuredAccount,
    secret,
    signal: controller.signal,
    state: stateStore(),
    onInbound: async (envelope) => {
      assert.deepEqual(envelope.attachments, [{ kind: "image" }]);
      assert.equal(JSON.stringify(envelope).includes("full_url"), false);
      downloaded = await adapter.downloadInbound({ account: configuredAccount, secret, envelope });
      controller.abort();
    },
    onStatus: () => undefined,
    log: () => undefined,
  });
  assert.equal(downloaded[0].kind, "image");
  assert.deepEqual(downloaded[0].data, Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1]));
});

test("runtime fails closed when Tencent reports a stale login token", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  globalThis.fetch = async (url) => (String(url).includes("getupdates") ? jsonResponse({ ret: -14 }) : jsonResponse());

  await assert.rejects(
    new WeixinAdapter().start({
      account: account(),
      secret: { token: "expired", providerAccountId: "provider", baseUrl: "https://example.test" },
      signal: new globalThis.AbortController().signal,
      state: stateStore(),
      onInbound: async () => undefined,
      onStatus: () => undefined,
      log: () => undefined,
    }),
    /凭证已失效/,
  );
});

test("runtime reconnects after a transient long-poll disconnect", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  let updateCalls = 0;
  globalThis.fetch = async (url) => {
    if (!String(url).includes("getupdates")) return jsonResponse();
    updateCalls += 1;
    if (updateCalls === 1) throw new Error("network offline");
    return jsonResponse({
      ret: 0,
      msgs: [
        {
          message_id: 202,
          message_type: 1,
          from_user_id: "user-two",
          item_list: [{ type: 1, text_item: { text: "back online" } }],
        },
      ],
      get_updates_buf: "cursor-reconnected",
    });
  };

  const controller = new globalThis.AbortController();
  const statuses = [];
  const adapter = new WeixinAdapter(async () => undefined);
  await adapter.start({
    account: account(),
    secret: { token: "secret", providerAccountId: "provider", baseUrl: "https://example.test" },
    signal: controller.signal,
    state: stateStore(),
    onInbound: async () => controller.abort(),
    onStatus: (status) => statuses.push(status),
    log: () => undefined,
  });

  assert.equal(updateCalls, 2);
  assert.equal(
    statuses.some((status) => status.state === "reconnecting" && status.retryCount === 1),
    true,
  );
});

test("QR confirmation returns a fresh credential for re-login", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  globalThis.fetch = async (url) => {
    const endpoint = String(url);
    if (endpoint.includes("get_bot_qrcode")) {
      return jsonResponse({ qrcode: "opaque-login", qrcode_img_content: "https://weixin.qq.com/x/relogin" });
    }
    if (endpoint.includes("get_qrcode_status")) {
      return jsonResponse({
        status: "confirmed",
        bot_token: "fresh-token",
        ilink_bot_id: "Bot Account 42",
        ilink_user_id: "owner-42",
        baseurl: "https://redirect.example.test",
      });
    }
    throw new Error(`Unexpected endpoint: ${endpoint}`);
  };

  const adapter = new WeixinAdapter();
  const started = await adapter.startLogin(true, ["stale-token"]);
  const confirmed = await adapter.pollLogin(started.sessionKey);

  assert.equal(started.phase, "qr");
  assert.equal(confirmed.event.phase, "confirmed");
  assert.equal(confirmed.event.accountId, "bot-account-42");
  assert.deepEqual(confirmed.credential, {
    token: "fresh-token",
    providerAccountId: "Bot Account 42",
    userId: "owner-42",
    baseUrl: "https://redirect.example.test",
  });
});
