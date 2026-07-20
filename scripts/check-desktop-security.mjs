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
const diagnosticsRedaction = read("src/main/diagnostics-redaction.ts");
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
const desktopIpc = read("src/main/ipc.ts");
const updateAdapter = read("src/main/update-adapter.ts");
const updateManager = read("src/main/update-manager.ts");
const electronBuilderConfig = read("electron-builder.yml");
const desktopBuildWorkflow = read(".github/workflows/build-desktop.yml");
const toolchainContractCheck = read("scripts/check-toolchain-contract.mjs");
const upstreamToolchainCatalogCheck = read("scripts/verify-toolchain-catalog-upstream.mjs");
const bundledToolsBuild = read("scripts/prepare-bundled-tools.mjs");
const packagedToolchainVerifier = read("scripts/verify-packaged-toolchains.mjs");
const toolchainSearch = read("src/agent-host/toolchain-search.ts");
const toolchainInstaller = read("src/main/toolchains/installer.ts");
const toolchainManager = read("src/main/toolchains/manager.ts");
const electronRuntimeFetch = read("src/main/toolchains/electron-runtime-fetch.ts");
const legacyNpmCommand = read("src/main/toolchains/legacy-npm-command.ts");
const toolchainStateStore = read("src/main/toolchains/state-store.ts");
const verifyScript = read("scripts/verify.mjs");
const rendererCsp = protocol.slice(protocol.indexOf("const CSP ="), protocol.indexOf("const HTML_PREVIEW_CSP ="));

const checks = [
  [windowFactory.includes("sandbox: true"), "BrowserWindow sandbox must remain enabled"],
  [windowFactory.includes("contextIsolation: true"), "context isolation must remain enabled"],
  [windowFactory.includes("nodeIntegration: false"), "renderer Node integration must remain disabled"],
  [main.includes("crashReporter.start"), "local crash reporting must be started"],
  [
    main.includes("createElectronRuntimeFetch") &&
      main.includes("net.request") &&
      !main.includes("net.fetch") &&
      electronRuntimeFetch.includes("request.followRedirect()") &&
      electronRuntimeFetch.includes("assertRuntimeRedirectUrl") &&
      main.includes("fetchImpl:") &&
      toolchainInstaller.includes("fetchImpl: options.fetchImpl"),
    "managed downloads must use Electron networking with synchronous redirect checks so system proxy and trust settings remain effective",
  ],
  [main.includes("setOverlayIcon"), "Windows taskbar overlay badges must remain implemented"],
  [
    diagnostics.includes('app.getPath("crashDumps")') &&
      diagnostics.includes("collectCrashMetadata") &&
      diagnostics.includes("MAX_LOG_BYTES") &&
      !diagnostics.includes("fs.cpSync") &&
      diagnosticsRedaction.includes("redactDiagnosticText") &&
      diagnosticsRedaction.includes("<redacted-token>") &&
      diagnosticsRedaction.includes("buildToolchainDiagnosticSummary"),
    "diagnostic export must redact bounded logs, summarize toolchains, and exclude raw crash process memory",
  ],
  [!/script-src[^;]*unsafe-inline/.test(rendererCsp), "renderer script-src must not allow unsafe-inline"],
  [fileViewer.includes('sandbox="allow-scripts"'), "HTML previews must remain sandboxed"],
  [
    protocol.includes("\"object-src 'none'; \"") && protocol.includes("\"form-action 'none'\""),
    "HTML preview CSP must block plugins and forms",
  ],
  [
    desktopBuildWorkflow.includes("check:toolchain-catalog:upstream") &&
      upstreamToolchainCatalogCheck.includes("SHASUMS256.txt") &&
      upstreamToolchainCatalogCheck.includes("asset.digest") &&
      upstreamToolchainCatalogCheck.includes("asset.size"),
    "tag releases must verify managed runtime checksums and sizes against official upstream metadata",
  ],
  [
    rpcManager.includes("createDesktopSearchToolDefinitions") &&
      toolchainSearch.includes("allowUpstreamDownload: false") &&
      !toolchainSearch.includes("ensureTool") &&
      !toolchainSearch.includes("releases/latest") &&
      bundledToolsBuild.includes("downloadRuntimeArtifact") &&
      bundledToolsBuild.includes("verifyDownloadedArtifact"),
    "Desktop grep/find must use injected rg/fd descriptors and fixed build-time assets without upstream dynamic downloads",
  ],
  [
    main.includes('app.isPackaged && process.argv.includes("--validate-packaged-startup")') &&
      main.includes("packaged-startup-check.json") &&
      main.includes("getToolchainAckRevision") &&
      main.includes('candidate.provider === "bundled"') &&
      main.includes('candidate.health === "healthy"'),
    "the production startup probe must be packaged-only and require Renderer, Host revision ack, and healthy bundled search tools",
  ],
  [
    packagedToolchainVerifier.includes("darwin-arm64|darwin-x64|win32-x64|linux-x64") &&
      packagedToolchainVerifier.includes(
        'assertExact(entries, ["core", "core-catalog.json", "runtime-catalog.json"]',
      ) &&
      packagedToolchainVerifier.includes("verifyManifestFile") &&
      packagedToolchainVerifier.includes("verifyLinuxSandbox") &&
      packagedToolchainVerifier.includes("stat.uid !== 0") &&
      packagedToolchainVerifier.includes('spawnSync(byComponent.get("ripgrep")') &&
      packagedToolchainVerifier.includes("runPackagedStartup") &&
      packagedToolchainVerifier.includes("verifyLinuxAppImageDesktopEntry") &&
      packagedToolchainVerifier.includes('APPIMAGE_EXTRACT_AND_RUN: "1"') &&
      packagedToolchainVerifier.includes("hostAckRevision !== report.revision"),
    "the packaged E2E must enforce the release matrix, exact resources, hashes, functional rg/fd, and production startup ack",
  ],
  [
    ["darwin-arm64", "darwin-x64", "win32-x64", "linux-x64"].every((target) => desktopBuildWorkflow.includes(target)) &&
      desktopBuildWorkflow.includes("check:packaged-toolchains") &&
      desktopBuildWorkflow.includes("release-linux") &&
      desktopBuildWorkflow.includes("xvfb-run --auto-servernum") &&
      desktopBuildWorkflow.includes("sudo chown root:root dist/linux-unpacked/chrome-sandbox") &&
      desktopBuildWorkflow.includes("sudo chmod 4755 dist/linux-unpacked/chrome-sandbox") &&
      electronBuilderConfig.includes("executableName: pi-agent-desktop") &&
      electronBuilderConfig.includes("--appimage-desktop-launch") &&
      !electronBuilderConfig.includes("--no-sandbox") &&
      desktopBuildWorkflow.includes("Pi-Agent-Desktop-${version}-x86_64.AppImage"),
    "CI and tag releases must run packaged toolchain E2E for every supported target, including Linux under Xvfb",
  ],
  [
    toolchainInstaller.includes("previousRoot") &&
      toolchainInstaller.includes("fs.renameSync(finalRoot, previousRoot)") &&
      toolchainInstaller.includes("this.stateStore.update") &&
      toolchainInstaller.includes("fs.renameSync(previousRoot, finalRoot)") &&
      toolchainInstaller.indexOf("this.stateStore.update") < toolchainInstaller.indexOf("fs.rmSync(previousRoot"),
    "managed activation must preserve the previous same-version runtime until the new state is durable",
  ],
  [
    toolchainInstaller.includes("recoverInterruptedOperations") &&
      toolchainInstaller.includes("cleanupPartialDownloads") &&
      toolchainInstaller.includes("recoverPreviousRuntimeDirectories") &&
      toolchainInstaller.includes("TOOLCHAIN_CANCELLED") &&
      toolchainManager.includes("cancelComponentInstall") &&
      toolchainManager.includes("isRuntimeInUse()"),
    "managed installs must support cancellation, crash-residue recovery, and in-use removal protection",
  ],
  [
    main.includes("readLegacyNpmCommand") &&
      legacyNpmCommand.includes("MAX_SETTINGS_BYTES") &&
      legacyNpmCommand.includes("validateLegacyNpmCommand") &&
      !legacyNpmCommand.includes("writeFile") &&
      toolchainManager.includes('intent === "plugin-install"') &&
      toolchainManager.includes('candidate.discovery === "legacy-npm-command"'),
    "legacy npmCommand migration must remain bounded, read-only, probed, and scoped to plugin compatibility",
  ],
  [
    toolchainStateStore.includes("hasFutureSchema") &&
      toolchainStateStore.includes("compatibilityReadOnly") &&
      toolchainStateStore.includes("primaryHasFutureSchema") &&
      toolchainStateStore.includes("written by a newer Pi Desktop"),
    "future toolchain state must remain read-only so application rollback cannot overwrite managed runtime ownership",
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
    feishuChannelApi.includes("im.v1.messageResource.get") &&
      feishuChannelApi.includes("FEISHU_MEDIA_MAX_BYTES") &&
      feishuChannelApi.includes("readLimitedStream"),
    "Feishu inbound media must use the message resource API with a local byte limit",
  ],
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
  [
    toolchainContractCheck.includes("ToolchainActionRequest") &&
      toolchainContractCheck.includes("forbiddenPattern") &&
      toolchainContractCheck.includes("url|uri|sha|hash|path|executable|argv|command") &&
      verifyScript.includes('run("toolchain contract safety"'),
    "renderer toolchain actions must retain the URL/hash/path/executable/argv/command safety gate",
  ],
  [
    desktopContract.includes("getToolchainState") &&
      desktopContract.includes("rescanToolchains") &&
      desktopContract.includes("performToolchainAction") &&
      desktopContract.includes("onToolchainState") &&
      preload.includes('ipcRenderer.invoke("desktop:toolchains:get-state"') &&
      preload.includes('ipcRenderer.invoke("desktop:toolchains:rescan"') &&
      preload.includes('ipcRenderer.invoke("desktop:toolchains:action"') &&
      preload.includes('ipcRenderer.on("toolchains:state"') &&
      desktopIpc.includes('ipcMain.handle("desktop:toolchains:get-state"') &&
      desktopIpc.includes('ipcMain.handle("desktop:toolchains:rescan"') &&
      desktopIpc.includes('ipcMain.handle("desktop:toolchains:action"') &&
      desktopIpc.includes("isToolchainActionRequest") &&
      desktopIpc.includes("assertTrustedToolchainSender(event)") &&
      desktopIpc.includes("event.senderFrame !== win.webContents.mainFrame") &&
      desktopIpc.includes("toolchainActionConfirmation(request)") &&
      desktopIpc.includes("dialog.showMessageBox") &&
      desktopIpc.includes("validateOptionalToolchainCwd"),
    "toolchain bridge must validate senders/actions/workspaces and keep download/destructive consent in Main",
  ],
  [
    main.includes('method === "toolchain.resolve"') &&
      main.includes('typeof body.trusted !== "boolean"') &&
      !desktopContract.includes("trustedProject") &&
      !desktopContract.includes("projectTrusted"),
    "project-local tool trust must come from the app-owned Host and never from the Renderer bridge",
  ],
  [
    desktopContract.includes("getUpdateState") &&
      desktopContract.includes("checkForUpdates") &&
      desktopContract.includes("downloadUpdate") &&
      desktopContract.includes("installUpdate") &&
      !/(?:setFeedURL|feedUrl|feedURL)/.test(desktopContract),
    "renderer updater contract must expose fixed actions without a configurable feed",
  ],
  [
    preload.includes('ipcRenderer.invoke("desktop:update:check")') &&
      preload.includes('ipcRenderer.invoke("desktop:update:download")') &&
      preload.includes('ipcRenderer.invoke("desktop:update:install")') &&
      preload.includes('ipcRenderer.on("update:state"'),
    "preload updater bridge must use fixed IPC channels",
  ],
  [
    desktopIpc.includes('ipcMain.handle("desktop:update:set-automatic-checks"') &&
      desktopIpc.includes('typeof enabled !== "boolean"') &&
      !/(?:setFeedURL|feedUrl|feedURL)/.test(desktopIpc),
    "updater IPC must validate its only mutable preference and reject feed configuration",
  ],
  [
    updateAdapter.includes("updater.autoDownload = false") &&
      updateAdapter.includes("updater.autoInstallOnAppQuit = true") &&
      updateAdapter.includes("updater.allowPrerelease = false") &&
      updateAdapter.includes("updater.allowDowngrade = false") &&
      updateAdapter.includes("updater.disableWebInstaller = true") &&
      updateAdapter.includes("updater.logger = null") &&
      updateAdapter.includes('platform === "darwin"') &&
      updateAdapter.includes('platform === "win32"') &&
      !updateAdapter.includes("WINDOWS_UPDATES_RELEASE_READY") &&
      !updateAdapter.includes("process.env"),
    "production updater must support macOS and Windows while remaining stable-only, consent-first, and using redacted application logging",
  ],
  [
    !/^\s*publisherName\s*:/im.test(electronBuilderConfig) &&
      desktopBuildWorkflow.includes("publisherName field in an unsigned Windows release") &&
      desktopBuildWorkflow.includes("/^\\s*publisherName\\s*:/im"),
    "unsigned Windows updates must omit publisher verification in both build configuration and packaged release checks",
  ],
  [
    updateManager.includes('platform === "darwin" || platform === "win32"') &&
      updateManager.includes("options.isPackaged || explicitlyEnabledForDevelopment") &&
      updateManager.includes("redactUpdateError") &&
      updateManager.includes("setRunningSessionCount"),
    "updater manager must retain platform/package gating, redaction, and active-session protection",
  ],
  [
    main.includes("createProductionUpdateAdapter") &&
      main.includes('win.webContents.send("update:state", state)') &&
      main.includes("updateManager?.setRunningSessionCount(ids.length)") &&
      main.includes("updateManager.startAutomaticChecks()"),
    "main process must own updater initialization, state publication, and session-aware scheduling",
  ],
];

const failures = checks.filter(([ok]) => !ok).map(([, message]) => message);
if (failures.length > 0) {
  for (const failure of failures) console.error(`FAIL: ${failure}`);
  process.exit(1);
}

console.log(`OK: ${checks.length} desktop security invariants hold`);
