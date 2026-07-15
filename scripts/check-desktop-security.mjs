#!/usr/bin/env node
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");
const main = read("src/main/main.ts");
const windowFactory = read("src/main/window.ts");
const protocol = read("src/main/protocol.ts");
const html = read("src/renderer/index.html");
const preload = read("src/preload/preload.ts");
const globals = read("src/renderer/global.d.ts");
const diagnostics = read("src/main/diagnostics.ts");
const fileViewer = read("src/renderer/components/FileViewer.tsx");
const credentialVault = read("src/main/credential-vault.ts");
const weixinChannelApi = read("src/agent-host/channels/adapters/weixin/api.ts");
const telegramChannelApi = read("src/agent-host/channels/adapters/telegram/api.ts");
const feishuChannelApi = read("src/agent-host/channels/adapters/feishu/api.ts");
const channelManager = read("src/agent-host/channels/channel-manager.ts");
const channelMediaStore = read("src/agent-host/channels/media-store.ts");
const channelOutboundFiles = read("src/agent-host/channels/outbound-files.ts");
const channelPiBridge = read("src/agent-host/channels/pi-session-bridge.ts");
const rpcManager = read("src/agent-host/rpc-manager.ts");
const weixinMedia = read("src/agent-host/channels/adapters/weixin/media.ts");
const channelContract = read("src/contract/api.ts");
const desktopContract = read("src/contract/desktop.ts");
const rendererCsp = protocol.slice(protocol.indexOf("const CSP ="), protocol.indexOf("const HTML_PREVIEW_CSP ="));

const checks = [
  [windowFactory.includes("sandbox: true"), "BrowserWindow sandbox must remain enabled"],
  [windowFactory.includes("contextIsolation: true"), "context isolation must remain enabled"],
  [windowFactory.includes("nodeIntegration: false"), "renderer Node integration must remain disabled"],
  [main.includes("crashReporter.start"), "local crash reporting must be started"],
  [main.includes("setOverlayIcon"), "Windows taskbar overlay badges must remain implemented"],
  [diagnostics.includes('app.getPath("crashDumps")'), "diagnostic export must include local crash dumps"],
  [!/script-src[^;]*unsafe-inline/.test(rendererCsp), "renderer script-src must not allow unsafe-inline"],
  [fileViewer.includes('sandbox="allow-scripts"'), "HTML previews must remain sandboxed"],
  [
    protocol.includes("\"object-src 'none'; \"") && protocol.includes("\"form-action 'none'\""),
    "HTML preview CSP must block plugins and forms",
  ],
  [!/<script(?![^>]*\bsrc=)[^>]*>/i.test(html), "renderer HTML must not contain inline scripts"],
  [preload.includes("../contract/desktop"), "preload must use the shared desktop bridge contract"],
  [globals.includes("../contract/desktop"), "renderer globals must use the shared desktop bridge contract"],
  [credentialVault.includes("safeStorage.encryptString"), "channel credentials must use Electron safeStorage"],
  [credentialVault.includes("safeStorage.isEncryptionAvailable"), "channel credential persistence must fail closed"],
  [!/(createServer|\.listen\s*\()/.test(weixinChannelApi), "Weixin MVP must not open a local listener"],
  [!/(createServer|\.listen\s*\()/.test(telegramChannelApi), "Telegram polling must not open a local listener"],
  [!/(createServer|\.listen\s*\()/.test(feishuChannelApi), "Feishu WebSocket mode must not open a local listener"],
  [
    channelManager.indexOf("evaluateInboundPolicy") < channelManager.indexOf("adapter.downloadInbound"),
    "channel access policy must run before provider media download",
  ],
  [
    channelMediaStore.includes("CHANNEL_MEDIA_MAX_BYTES") &&
      channelMediaStore.includes("CHANNEL_MEDIA_MAX_ATTACHMENTS") &&
      channelMediaStore.includes("info.isSymbolicLink()") &&
      channelMediaStore.includes("mode: 0o600"),
    "channel media staging must retain byte/count/symlink/private-file controls",
  ],
  [
    channelOutboundFiles.includes("realpath") &&
      channelOutboundFiles.includes("MARKDOWN_LINK") &&
      channelOutboundFiles.includes("isInside(canonical, root)") &&
      channelPiBridge.includes("collectOutboundFiles({ finalText: result.finalText, cwd })"),
    "linked-file delivery must remain inside the actual bound session workspace",
  ],
  [
    weixinMedia.includes('url.protocol !== "https:"') && weixinMedia.includes('redirect: "error"'),
    "Weixin media must use trusted HTTPS origins without cross-origin redirects",
  ],
  [
    channelPiBridge.includes("channelPromptText(envelope.text") && !channelPiBridge.includes("[外部消息来源："),
    "channel user prompts must contain the user's text without transport metadata wrappers",
  ],
  [
    rpcManager.includes("expandPromptTemplates: false") && rpcManager.includes("stripLegacyChannelPrompts"),
    "channel prompts must avoid local expansion and remove legacy transport metadata from model history",
  ],
  [
    !channelContract.includes("botToken") && !channelContract.includes("appSecret"),
    "channel RPC must not expose raw secrets",
  ],
  [
    desktopContract.includes("setChannelCredential") && !desktopContract.includes("getChannelCredential"),
    "renderer channel credential bridge must remain write-only",
  ],
];

const failures = checks.filter(([ok]) => !ok).map(([, message]) => message);
if (failures.length > 0) {
  for (const failure of failures) console.error(`FAIL: ${failure}`);
  process.exit(1);
}

console.log(`OK: ${checks.length} desktop security invariants hold`);
