import { importTestBundle } from "#test-bundle";
import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

const { AccountCard, FEISHU_PERMISSION_IMPORT_JSON, FeishuCredentialDialog, LoginDialog, TelegramTokenDialog } =
  await importTestBundle("src/renderer/components/channels/channels-config", {
    stdin: {
      contents:
        'export { AccountCard, FEISHU_PERMISSION_IMPORT_JSON, FeishuCredentialDialog, LoginDialog, TelegramTokenDialog } from "./ChannelsConfig.tsx";',
      resolveDir: import.meta.dirname,
      sourcefile: "channels-config-test-entry.tsx",
      loader: "tsx",
    },
    tsconfig: path.join(import.meta.dirname, "../../../../tsconfig.renderer.json"),
    external: ["react", "react-dom", "react-dom/*", "@rc-component/qrcode"],
  });

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
  assert.match(html, /Default tools/);
  assert.match(html, /synchronized to sessions currently bound to this account/);
});

test("Feishu setup dialog provides one-click batch permission import and concise guidance", () => {
  const html = renderToStaticMarkup(
    createElement(FeishuCredentialDialog, {
      busy: false,
      error: "",
      initialMode: "manual",
      onStartScan() {},
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
  assert.match(html, /im:resource/);
  assert.match(html, /cardkit:card:write/);
  assert.match(html, /Batch import\/export scopes/);
  assert.match(html, /Copy permission JSON/);
  assert.doesNotMatch(html, /Long-connection guide/);
  assert.doesNotMatch(html, /Streaming-card guide/);
  assert.match(html, /Publish a new app version/);
});

test("Feishu connection defaults to scan-create while keeping the existing-app fallback", () => {
  const html = renderToStaticMarkup(
    createElement(FeishuCredentialDialog, {
      busy: false,
      error: "",
      onStartScan() {},
      onConnect() {},
      onClose() {},
    }),
  );
  assert.match(html, /data-testid="feishu-scan-tab"/);
  assert.match(html, /data-testid="feishu-manual-tab"/);
  assert.match(html, /data-testid="feishu-scan-create"/);
  assert.match(html, /data-testid="start-feishu-scan"/);
  assert.match(html, /Scan to create \(recommended\)/);
  assert.match(html, /Creates a new bot/);
  assert.match(html, /only allowed DM sender/);
  assert.match(html, /Existing app/);
  assert.doesNotMatch(html, /type="password"/);
  assert.doesNotMatch(html, /data-testid="feishu-permission-json"/);
});

test("Feishu existing-app setup remains available when manual mode is selected", () => {
  const html = renderToStaticMarkup(
    createElement(FeishuCredentialDialog, {
      busy: false,
      error: "",
      initialMode: "manual",
      onStartScan() {},
      onConnect() {},
      onClose() {},
    }),
  );
  assert.match(html, /data-testid="feishu-existing-app"/);
  assert.match(html, /data-testid="feishu-scan-tab"/);
  assert.match(html, /data-testid="feishu-manual-tab"/);
  assert.match(html, /type="password"/);
  assert.match(html, /data-testid="feishu-permission-json"/);
  assert.doesNotMatch(html, /data-testid="start-feishu-scan"/);
});

test("generic channel login dialog renders Feishu QR state without exposing credentials", () => {
  const html = renderToStaticMarkup(
    createElement(LoginDialog, {
      event: {
        channel: "feishu",
        sessionKey: "session-one",
        phase: "qr",
        message: "Scan to create a new bot",
        qrContent: "https://accounts.feishu.cn/oauth/device?opaque=value",
        expiresAt: Date.now() + 60_000,
      },
      code: "",
      setCode() {},
      onSubmitCode() {},
      onClose() {},
    }),
  );
  assert.match(html, /data-testid="channel-login-dialog-feishu"/);
  assert.match(html, /Scan to create Feishu \/ Lark bot/);
  assert.match(html, /Feishu \/ Lark app creation QR code/);
  assert.match(html, /QR code expires in/);
  assert.doesNotMatch(html, /client_secret|App Secret/);
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
        "im:resource",
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
