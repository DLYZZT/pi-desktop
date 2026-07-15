import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { build } from "esbuild";

const output = path.join(
  import.meta.dirname,
  "../../../../.artifacts/test-modules",
  `channels-config-${process.pid}.mjs`,
);
mkdirSync(path.dirname(output), { recursive: true });
await build({
  stdin: {
    contents:
      'export { AccountCard, FEISHU_PERMISSION_IMPORT_JSON, FeishuCredentialDialog, TelegramTokenDialog } from "./ChannelsConfig.tsx";',
    resolveDir: import.meta.dirname,
    sourcefile: "channels-config-test-entry.tsx",
    loader: "tsx",
  },
  outfile: output,
  tsconfig: path.join(import.meta.dirname, "../../../../tsconfig.renderer.json"),
  bundle: true,
  format: "esm",
  platform: "node",
  external: ["react", "react-dom", "react-dom/*", "@rc-component/qrcode"],
  logLevel: "silent",
});

const { AccountCard, FEISHU_PERMISSION_IMPORT_JSON, FeishuCredentialDialog, TelegramTokenDialog } = await import(
  `${pathToFileURL(output).href}?v=${Date.now()}`
);

test("Telegram token dialog renders connection failures without closing", () => {
  const html = renderToStaticMarkup(
    createElement(TelegramTokenDialog, {
      busy: false,
      error: "Telegram getMe failed",
      onConnect() {},
      onClose() {},
    }),
  );
  assert.match(html, /data-testid="telegram-connect-error"/);
  assert.match(html, /Telegram getMe failed/);
});

test("channel account settings expose the opt-in IM command switch", () => {
  const now = new Date().toISOString();
  const html = renderToStaticMarkup(
    createElement(AccountCard, {
      account: {
        id: "telegram-one",
        channel: "telegram",
        name: "Pi Bot",
        enabled: true,
        dmPolicy: "pairing",
        allowFrom: [],
        groupPolicy: "disabled",
        groupIds: [],
        groupAllowFrom: [],
        requireMention: true,
        commandsEnabled: false,
        toolNames: [],
        createdAt: now,
        updatedAt: now,
        configured: true,
      },
      busy: false,
      onSave() {},
      onStart() {},
      onStop() {},
      onRestart() {},
      async onProbe() {
        return { ok: true, message: "ok", accountId: "telegram-one" };
      },
      async onUpdateToken() {
        return { ok: true, message: "ok", accountId: "telegram-one" };
      },
      async onUpdateFeishuCredential() {
        return { ok: true, message: "ok", accountId: "telegram-one" };
      },
      onTestSend() {},
      onDelete() {},
    }),
  );
  assert.match(html, /IM commands/);
  assert.match(html, /Enable \/help, \/status, \/new, \/compact, and \/reload/);
});

test("Feishu setup dialog provides one-click batch permission import and concise guidance", () => {
  const html = renderToStaticMarkup(
    createElement(FeishuCredentialDialog, {
      busy: false,
      error: "",
      onConnect() {},
      onClose() {},
    }),
  );
  assert.match(html, /data-testid="feishu-connect-dialog"/);
  assert.match(html, /Feishu \(China\)/);
  assert.match(html, /Lark/);
  assert.match(html, /im\.message\.receive_v1/);
  assert.match(html, /application\.bot\.menu_v6/);
  assert.match(html, /pi_help/);
  assert.match(html, /pi_status/);
  assert.match(html, /data-testid="feishu-permission-json"/);
  assert.match(html, /data-testid="copy-feishu-permission-json"/);
  assert.match(html, /im:message/);
  assert.match(html, /im:message\.p2p_msg:readonly/);
  assert.match(html, /im:message\.group_at_msg:readonly/);
  assert.match(html, /im:message:send_as_bot/);
  assert.match(html, /im:message\.reactions:write_only/);
  assert.match(html, /cardkit:card:write/);
  assert.match(html, /Batch import\/export scopes/);
  assert.match(html, /Copy permission JSON/);
  assert.doesNotMatch(html, /Long-connection guide/);
  assert.doesNotMatch(html, /Streaming-card guide/);
  assert.match(html, /Publish a new app version/);
});

test("Feishu permission import JSON contains only tenant scopes required by the channel", () => {
  assert.deepEqual(JSON.parse(FEISHU_PERMISSION_IMPORT_JSON), {
    scopes: {
      tenant: [
        "im:message",
        "im:message.p2p_msg:readonly",
        "im:message.group_at_msg:readonly",
        "im:message:send_as_bot",
        "im:message.reactions:write_only",
        "cardkit:card:write",
      ],
      user: [],
    },
  });
});

test("Feishu account settings expose App ID, domain, and hot credential rotation", () => {
  const now = new Date().toISOString();
  const html = renderToStaticMarkup(
    createElement(AccountCard, {
      account: {
        id: "feishu-one",
        channel: "feishu",
        name: "Pi Feishu Bot",
        enabled: true,
        appId: "cli_1234567890abcdef",
        domain: "feishu",
        dmPolicy: "pairing",
        allowFrom: [],
        groupPolicy: "disabled",
        groupIds: [],
        groupAllowFrom: [],
        requireMention: true,
        commandsEnabled: false,
        toolNames: [],
        createdAt: now,
        updatedAt: now,
        configured: true,
      },
      busy: false,
      onSave() {},
      onStart() {},
      onStop() {},
      onRestart() {},
      async onProbe() {
        return { ok: true, message: "ok", accountId: "feishu-one" };
      },
      async onUpdateToken() {
        return { ok: true, message: "ok", accountId: "feishu-one" };
      },
      async onUpdateFeishuCredential() {
        return { ok: true, message: "ok", accountId: "feishu-one" };
      },
      onTestSend() {},
      onDelete() {},
    }),
  );
  assert.match(html, /data-testid="feishu-credential-settings"/);
  assert.match(html, /cli_1234567890abcdef/);
  assert.match(html, /New App Secret/);
  assert.match(html, /hot-reloads its WebSocket connection/);
  assert.match(html, /data-testid="feishu-rich-card-hint"/);
  assert.match(html, /cardkit:card:write/);
});
