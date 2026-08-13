import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const read = (url) => fs.readFileSync(url, "utf8");
const appShell = read(new URL("../AppShell.tsx", import.meta.url));
const settingsConfig = read(new URL("../SettingsConfig.tsx", import.meta.url));
const messageView = read(new URL("../MessageView.tsx", import.meta.url));
const browserDock = read(new URL("./BrowserDock.tsx", import.meta.url));
const browserSettings = read(new URL("./BrowserSettings.tsx", import.meta.url));
const browserAuthorization = read(new URL("./BrowserAuthorizationDialog.tsx", import.meta.url));
const browserService = read(new URL("../../../main/browser/browser-service.ts", import.meta.url));
const browserTabManager = read(new URL("../../../main/browser/browser-tab-manager.ts", import.meta.url));
const mainProcess = read(new URL("../../../main/main.ts", import.meta.url));
const mainWindow = read(new URL("../../../main/window.ts", import.meta.url));
const i18n = read(new URL("../../i18n-dictionaries.ts", import.meta.url));

test("Browser remains a fixed right-panel resource and hides its native surface behind Settings", () => {
  assert.match(appShell, /const BROWSER_TAB_ID = "browser"/);
  assert.match(appShell, /t\("browser", "Browser"\)/);
  assert.match(appShell, /rightPanelOpen && !settingsOpen && !browserAuthorization/);
  assert.match(appShell, /persistRightPanelPreferredWidth\(finalWidth, activeFileTabId === BROWSER_TAB_ID\)/);
});

test("BrowserDock synchronizes native bounds, visibility, session ownership, and tool-result navigation", () => {
  assert.match(browserDock, /new ResizeObserver\(sync\)/);
  assert.match(browserDock, /browserSetBounds\(/);
  assert.match(browserDock, /browserSetSurfaceVisible\(/);
  assert.match(browserDock, /tab\.ownerSessionId === null \|\| tab\.ownerSessionId === ownerSessionId/);
  assert.match(browserDock, /message\.includes\("TAB_NOT_FOUND"\)/);
  assert.match(messageView, /pi-desktop:open-browser-tab/);
});

test("Main fails closed across Renderer reloads and hidden screenshots never present the native View", () => {
  assert.match(mainWindow, /onRendererUnavailable\?: \(reason: string\) => void/);
  assert.match(mainWindow, /did-start-loading[\s\S]*onRendererUnavailable/);
  assert.match(mainWindow, /render-process-gone[\s\S]*onRendererUnavailable/);
  assert.match(mainProcess, /onRendererUnavailable: \(\) => browserService\?\.handleRendererUnavailable\(\)/);
  assert.match(browserService, /handleRendererUnavailable\(\)[\s\S]*hideSurfaceForRendererUnavailable\(\)/);
  assert.match(browserTabManager, /hideSurfaceForRendererUnavailable\(\)[\s\S]*surfaceRequestedVisible = false/);
  const screenshotBody = browserTabManager.slice(
    browserTabManager.indexOf("async screenshot("),
    browserTabManager.indexOf("async click("),
  );
  assert.match(screenshotBody, /stayHidden: true/);
  assert.doesNotMatch(screenshotBody, /setVisible\(true\)/);
});

test("Browser access is demand-prompted and AppShell never eagerly grants a selected session", () => {
  assert.doesNotMatch(appShell, /browserGrantSession/);
  assert.match(appShell, /agent-authorization-request/);
  assert.match(appShell, /browserRespondAgentAuthorization/);
  assert.match(browserAuthorization, /role="dialog"/);
  assert.match(browserAuthorization, /denyRef/);
  assert.match(browserAuthorization, /event\.key === "Escape"/);
});

test("Browser Settings is reachable and separates permanent policy from temporary grants", () => {
  assert.match(settingsConfig, /id: "browser"/);
  assert.match(settingsConfig, /<BrowserSettings sessionId=/);
  assert.doesNotMatch(browserSettings, /browserGrantSession/);
  assert.match(browserSettings, /browserSetPersistentSessionPermission/);
  assert.match(browserSettings, /browserRevokeTemporarySessionPermission/);
  assert.match(browserSettings, /browserRequestConfirmation\("advanced-browser-mode"/);
  assert.doesNotMatch(browserSettings, /browserSetUnsafePolicy|ENABLE UNSAFE BROWSER/);
  assert.match(browserSettings, /browserReset\(\)/);
});

test("Settings categories use a vertical sidebar with matching keyboard navigation", () => {
  assert.match(settingsConfig, /aria-orientation="vertical"/);
  assert.match(settingsConfig, /flexDirection: "column"/);
  assert.match(settingsConfig, /borderRight: "1px solid var\(--border\)"/);
  assert.match(settingsConfig, /id: "plugins"[\s\S]*id: "browser"[\s\S]*id: "channels"/);
  assert.match(settingsConfig, /event\.key === "ArrowDown"/);
  assert.match(settingsConfig, /event\.key === "ArrowUp"/);
  assert.match(settingsConfig, /event\.key === "Home"/);
  assert.match(settingsConfig, /event\.key === "End"/);
  assert.doesNotMatch(settingsConfig, /overflowX: "auto"/);
});

test("Browser Settings and Browser panel use the app language dictionary", () => {
  assert.match(browserSettings, /useI18n/);
  assert.match(browserSettings, /t\("browserSettingsTitle"/);
  assert.match(browserSettings, /t\("browserSessionPermanentPermission"/);
  assert.match(browserDock, /useI18n/);
  assert.match(browserDock, /t\("browserLoadingPanel"/);
  assert.match(browserSettings, /browserRequestConfirmation\("advanced-browser-mode", patch, language\)/);
  assert.match(browserService, /language === "zh-CN"/);
  assert.match(browserService, /启用高级浏览器模式/);
  assert.match(i18n, /browser: "浏览器"/);
  assert.match(i18n, /browserSettingsTitle: "内置浏览器"/);
  assert.match(i18n, /browserSessionPermanentPermission: "此会话的永久浏览器权限"/);
  assert.match(i18n, /browserLoadingPanel: "正在加载浏览器…"/);
});

test("Browser Settings uses an in-app text prompt instead of Electron's unsupported window.prompt", () => {
  assert.doesNotMatch(browserSettings, /window\.prompt/);
  assert.match(browserSettings, /function TextPromptDialog/);
  assert.match(browserSettings, /requiredValue: "ENABLE ADVANCED BROWSER"/);
  assert.doesNotMatch(browserSettings, /requiredValue: "ENABLE UNSAFE BROWSER"/);
  assert.match(browserSettings, /role="dialog"/);
});
