import { BrowserWindow, nativeTheme, screen, shell } from "electron";
import { appendMainLog } from "./logger";
import { resolvePreloadPath, resolveRendererEntry } from "./host-manager";
import { releaseHtmlPreviewsForOwner } from "./protocol";
import { createLoadFailurePage, createRendererCrashPage, RENDERER_CRASH_RETRY_URL } from "./window-load-failure";
import { isAllowedMainNavigation } from "./window-navigation-policy";
import { applyWindowBounds, loadUiState, shouldMaximize, trackWindowState } from "./window-state";
import { RendererCrashRecovery } from "./renderer-crash-recovery";
import { installWindowShowFallback } from "./window-show-fallback";

const LIGHT_BACKGROUND = "#f7f6f3";
const DARK_BACKGROUND = "#141210";

function currentTheme(): "light" | "dark" {
  return nativeTheme.shouldUseDarkColors ? "dark" : "light";
}

export type CreateMainWindowOptions = {
  isDev: boolean;
  show?: boolean;
  runtimeMainDirectory?: string;
  consumePendingDeepLink?: () => string | null;
  shouldHideOnClose?: () => boolean;
  onClosed?: (window: BrowserWindow) => void;
  onRendererUnavailable?: (reason: string) => void;
  onConsoleError?: (message: string) => void;
};

export function createMainWindow(options: CreateMainWindowOptions): BrowserWindow {
  const ui = loadUiState();
  const primaryWorkArea = screen.getPrimaryDisplay().workArea;
  const bounds = applyWindowBounds({ width: 1280, height: 840 }, ui, {
    primary: primaryWorkArea,
    all: screen.getAllDisplays().map((display) => display.workArea),
  });

  const win = new BrowserWindow({
    width: bounds.width,
    height: bounds.height,
    x: bounds.x,
    y: bounds.y,
    minWidth: 900,
    minHeight: 600,
    title: "Pi Agent Desktop",
    backgroundColor: nativeTheme.shouldUseDarkColors ? DARK_BACKGROUND : LIGHT_BACKGROUND,
    show: false,
    webPreferences: {
      preload: resolvePreloadPath(options.runtimeMainDirectory),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    },
  });
  const previewOwnerId = win.webContents.id;
  const rendererUrl = resolveRendererEntry(options.isDev, options.runtimeMainDirectory);
  const crashRecovery = new RendererCrashRecovery();
  let rendererReloadTimer: ReturnType<typeof setTimeout> | undefined;
  let showingCrashPage = false;

  trackWindowState(win);
  if (shouldMaximize(ui) && !win.isDestroyed()) win.maximize();

  const showWin = () => {
    if (options.show === false) return;
    if (!win.isDestroyed() && !win.isVisible()) {
      win.show();
      if (options.isDev || process.env.PI_DESKTOP_DEVTOOLS === "1") {
        win.webContents.openDevTools({ mode: "detach" });
      }
    }
  };
  installWindowShowFallback(win, showWin);

  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url) || /^mailto:/i.test(url)) void shell.openExternal(url);
    return { action: "deny" };
  });

  win.webContents.on("will-navigate", (event, url) => {
    if (url === RENDERER_CRASH_RETRY_URL) {
      event.preventDefault();
      crashRecovery.reset();
      showingCrashPage = false;
      if (rendererReloadTimer) clearTimeout(rendererReloadTimer);
      rendererReloadTimer = undefined;
      if (!win.isDestroyed()) void win.loadURL(rendererUrl);
      return;
    }
    if (!isAllowedMainNavigation(url, options.isDev)) {
      event.preventDefault();
      if (/^https?:/i.test(url)) void shell.openExternal(url);
    }
  });

  win.on("close", (event) => {
    if (options.shouldHideOnClose?.()) {
      event.preventDefault();
      win.hide();
    }
  });

  win.on("closed", () => {
    if (rendererReloadTimer) clearTimeout(rendererReloadTimer);
    rendererReloadTimer = undefined;
    releaseHtmlPreviewsForOwner(previewOwnerId);
    options.onClosed?.(win);
  });

  win.webContents.on("render-process-gone", (_event, details) => {
    releaseHtmlPreviewsForOwner(previewOwnerId);
    options.onRendererUnavailable?.(`render-process-gone:${details.reason}`);
    appendMainLog(`render-process-gone: ${details.reason}`);
    if (win.isDestroyed() || showingCrashPage) return;
    const action = crashRecovery.record(details.reason);
    if (action.kind === "ignore") return;
    if (action.kind === "halt") {
      showingCrashPage = true;
      const page = createRendererCrashPage(action.reason, currentTheme());
      void win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(page)}`);
      return;
    }
    appendMainLog(`renderer reload attempt=${action.attempt} delayMs=${action.delayMs}`);
    if (rendererReloadTimer) clearTimeout(rendererReloadTimer);
    rendererReloadTimer = setTimeout(() => {
      rendererReloadTimer = undefined;
      if (!win.isDestroyed()) void win.loadURL(rendererUrl);
    }, action.delayMs);
    rendererReloadTimer.unref?.();
  });

  // Main-owned child Views outlive the page Renderer. Hide them before the
  // page starts loading so a reload/HMR navigation cannot leave a stale native
  // surface above the replacement React UI.
  win.webContents.on("did-start-loading", () => {
    options.onRendererUnavailable?.("did-start-loading");
  });

  win.webContents.on("did-start-navigation", (_event, _url, isInPlace, isMainFrame) => {
    if (isMainFrame && !isInPlace) releaseHtmlPreviewsForOwner(previewOwnerId);
  });

  win.webContents.on("did-finish-load", () => {
    const pendingDeepLink = options.consumePendingDeepLink?.();
    if (pendingDeepLink) win.webContents.send("deep-link:session", pendingDeepLink);
  });

  win.webContents.on("did-fail-load", (_event, code, description, validatedURL, isMainFrame) => {
    if (!isMainFrame || code === -3) return;
    appendMainLog(`did-fail-load code=${code} desc=${description} url=${validatedURL}`);
    const help = createLoadFailurePage(code, description, validatedURL, currentTheme());
    void win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(help)}`);
  });

  win.webContents.on("console-message", (_event, level, message, line, sourceId) => {
    const isSessionPerformanceLog =
      options.isDev && (message.startsWith("[perf:sessions]") || message.startsWith("[perf:sessions:react]"));
    if (level < 2 && !isSessionPerformanceLog) return;
    appendMainLog(`renderer[${level}] ${message} (${sourceId}:${line})`);
    if (level >= 2) options.onConsoleError?.(message);
  });

  appendMainLog(`loadURL ${rendererUrl}`);
  void win.loadURL(rendererUrl);

  return win;
}
