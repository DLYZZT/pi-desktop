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
    contents: 'export { AccountCard, TelegramTokenDialog } from "./ChannelsConfig.tsx";',
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

const { AccountCard, TelegramTokenDialog } = await import(`${pathToFileURL(output).href}?v=${Date.now()}`);

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
      onTestSend() {},
      onDelete() {},
    }),
  );
  assert.match(html, /IM commands/);
  assert.match(html, /Enable \/help, \/status, \/new, \/compact, and \/reload/);
});
