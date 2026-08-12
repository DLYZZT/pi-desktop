import { BrowserWindow, shell } from "electron";
import { appendMainLog } from "./logger";
import { resolvePreloadPath, resolveRendererEntry } from "./host-manager";
import { isAllowedMainNavigation } from "./window-navigation-policy";
import { applyWindowBounds, loadUiState, shouldMaximize, trackWindowState } from "./window-state";

const BACKGROUND = "#f7f6f3";

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
  const bounds = applyWindowBounds(
    { x: undefined as unknown as number, y: undefined as unknown as number, width: 1280, height: 840 },
    ui,
  );

  const win = new BrowserWindow({
    width: bounds.width,
    height: bounds.height,
    x: bounds.x,
    y: bounds.y,
    minWidth: 900,
    minHeight: 600,
    title: "Pi Agent Desktop",
    backgroundColor: BACKGROUND,
    show: false,
    webPreferences: {
      preload: resolvePreloadPath(options.runtimeMainDirectory),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    },
  });

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
  win.once("ready-to-show", showWin);
  setTimeout(showWin, 3_000);

  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url) || /^mailto:/i.test(url)) void shell.openExternal(url);
    return { action: "deny" };
  });

  win.webContents.on("will-navigate", (event, url) => {
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

  win.on("closed", () => options.onClosed?.(win));

  win.webContents.on("render-process-gone", (_event, details) => {
    options.onRendererUnavailable?.(`render-process-gone:${details.reason}`);
    appendMainLog(`render-process-gone: ${details.reason}`);
    if (!win.isDestroyed()) win.reload();
  });

  // Main-owned child Views outlive the page Renderer. Hide them before the
  // page starts loading so a reload/HMR navigation cannot leave a stale native
  // surface above the replacement React UI.
  win.webContents.on("did-start-loading", () => {
    options.onRendererUnavailable?.("did-start-loading");
  });

  win.webContents.on("did-finish-load", () => {
    const pendingDeepLink = options.consumePendingDeepLink?.();
    if (pendingDeepLink) win.webContents.send("deep-link:session", pendingDeepLink);
  });

  win.webContents.on("did-fail-load", (_event, code, description, validatedURL, isMainFrame) => {
    if (!isMainFrame || code === -3) return;
    appendMainLog(`did-fail-load code=${code} desc=${description} url=${validatedURL}`);
    const help =
      `<!DOCTYPE html><html><body style="font-family:system-ui;background:#f7f6f3;padding:40px;color:#1c1a17">` +
      `<h1 style="font-family:ui-monospace,monospace;font-size:18px">Cannot load UI</h1>` +
      `<p style="color:#57534a;font-size:13.5px;line-height:1.55">Failed to load <code>${validatedURL}</code><br/>Error ${code}: ${description}</p>` +
      `<p style="color:#57534a;font-size:13.5px">Try: <code>npm run build && npm start</code> or <code>npm run dev</code></p>` +
      `</body></html>`;
    void win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(help)}`);
  });

  win.webContents.on("console-message", (_event, level, message, line, sourceId) => {
    const isSessionPerformanceLog =
      options.isDev && (message.startsWith("[perf:sessions]") || message.startsWith("[perf:sessions:react]"));
    if (level < 2 && !isSessionPerformanceLog) return;
    appendMainLog(`renderer[${level}] ${message} (${sourceId}:${line})`);
    if (level >= 2) options.onConsoleError?.(message);
  });

  const url = resolveRendererEntry(options.isDev, options.runtimeMainDirectory);
  appendMainLog(`loadURL ${url}`);
  void win.loadURL(url);

  return win;
}
