import { existsSync } from "node:fs";
import { copyFile, open, readFile, stat } from "node:fs/promises";
import path from "node:path";
import {
  BrowserWindow,
  clipboard,
  dialog,
  Menu,
  MenuItemConstructorOptions,
  nativeTheme,
  screen,
  shell,
} from "electron";
import type { ContextMenuParams } from "electron";
import { appendMainLog } from "./logger";
import { getFileAssociations, openWithDialog, runOpenWith } from "./file-associations";
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

function urlToWindowsPath(linkUrl: string | undefined): string | null {
  if (!linkUrl) return null;
  try {
    const url = new URL(linkUrl);
    if (url.protocol !== "file:") return null;
    const pathname = decodeURIComponent(url.pathname);
    // file://server/share -> //server/share (UNC); file:///C:/... -> C:/...
    if (url.host) return `//${url.host}${pathname}`;
    return /^\/[a-zA-Z]:\//.test(pathname) ? pathname.slice(1) : pathname;
  } catch {
    return null;
  }
}

function appendTextItems(template: MenuItemConstructorOptions[], params: ContextMenuParams, win: BrowserWindow) {
  let added = false;
  if (params.isEditable) {
    if (params.editFlags.canCut) {
      template.push({ label: "Cut", role: "cut" });
      added = true;
    }
    if (params.editFlags.canCopy) {
      template.push({ label: "Copy", role: "copy" });
      added = true;
    }
    if (params.editFlags.canPaste) {
      template.push({ label: "Paste", role: "paste" });
      added = true;
    }
  } else if (params.selectionText.trim().length > 0) {
    template.push(
      {
        label: `Copy`,
        click: () => clipboard.writeText(params.selectionText),
      },
      {
        label: `Search Google for "${params.selectionText.trim().slice(0, 42).replace(/"/g, "'")}"`,
        click: () =>
          void shell.openExternal(`https://www.google.com/search?q=${encodeURIComponent(params.selectionText.trim())}`),
      },
    );
    added = true;
  }
  if (added || template.length > 0) template.push({ type: "separator" });
  template.push({
    label: "Select All",
    click: () => void win.webContents.selectAll(),
  });
}

async function saveFileAs(win: BrowserWindow, srcPath: string): Promise<void> {
  const result = await dialog.showSaveDialog(win, { defaultPath: path.basename(srcPath) });
  if (result.canceled || !result.filePath) return;
  try {
    await copyFile(srcPath, result.filePath);
    shell.showItemInFolder(result.filePath);
  } catch {
    /* best-effort copy */
  }
}

async function canReadAsText(filePath: string): Promise<boolean> {
  try {
    const st = await stat(filePath);
    if (!st.isFile() || st.size > 1_000_000) return false;
    const handle = await open(filePath, "r");
    try {
      const probe = Buffer.alloc(Math.min(8192, st.size));
      const { bytesRead } = await handle.read(probe, 0, probe.length, 0);
      return !probe.subarray(0, bytesRead).includes(0);
    } finally {
      await handle.close();
    }
  } catch {
    return false;
  }
}

async function copyFileContents(filePath: string): Promise<void> {
  try {
    const buf = await readFile(filePath);
    clipboard.writeText(buf.toString("utf8"));
  } catch {
    /* ignore */
  }
}

export async function buildFileContextMenu(
  win: BrowserWindow,
  filePath: string,
  params: ContextMenuParams,
  options?: { withTextItems?: boolean },
): Promise<MenuItemConstructorOptions[]> {
  return buildFileContextMenuCore(win, filePath, params, options);
}

async function buildFileContextMenuCore(
  win: BrowserWindow,
  filePath: string,
  params: ContextMenuParams,
  options?: { withTextItems?: boolean },
): Promise<MenuItemConstructorOptions[]> {
  const template: MenuItemConstructorOptions[] = [];
  const fileExists = existsSync(filePath);
  const { defaultApp, handlers } = await getFileAssociations(filePath);

  template.push({ label: "Open file", enabled: fileExists, click: () => void shell.openPath(filePath) });
  if (defaultApp) {
    template.push({
      label: `Open in ${defaultApp.name}`,
      enabled: fileExists,
      click: () => runOpenWith(defaultApp.command, filePath),
    });
  }

  const openWithItems: MenuItemConstructorOptions[] = handlers.map((handler) => ({
    label: handler.name,
    enabled: fileExists,
    click: () => runOpenWith(handler.command, filePath),
  }));
  if (openWithItems.length > 0) openWithItems.push({ type: "separator" });
  openWithItems.push({
    label: "Choose another app…",
    enabled: fileExists,
    click: () => openWithDialog(filePath),
  });
  template.push({ label: "Open with", submenu: openWithItems });

  template.push({ type: "separator" });
  template.push({ label: "Save as…", enabled: fileExists, click: () => void saveFileAs(win, filePath) });
  template.push({ label: "Copy path", click: () => clipboard.writeText(filePath) });
  const readableAsText = fileExists && (await canReadAsText(filePath));
  template.push({
    label: "Copy file contents",
    enabled: readableAsText,
    click: () => void copyFileContents(filePath),
  });
  template.push({ label: "Show in folder", enabled: fileExists, click: () => shell.showItemInFolder(filePath) });

  // Skip text items (Cut/Copy/Paste, Select All) for renderer-driven menus:
  // the renderer supplies synthetic params, so those items would be junk.
  if (options?.withTextItems !== false) appendTextItems(template, params, win);
  return template;
}

function setupContextMenu(win: BrowserWindow) {
  win.webContents.on("context-menu", (_event, params) => {
    const filePath = urlToWindowsPath(params.linkURL);

    // Rich file menu on Windows (registry-backed "Open with"); built async.
    if (filePath && process.platform === "win32") {
      void buildFileContextMenu(win, filePath, params)
        .then((template) => {
          if (!win.isDestroyed()) Menu.buildFromTemplate(template).popup({ window: win });
        })
        .catch(() => {});
      return;
    }

    const template: MenuItemConstructorOptions[] = [];
    if (filePath) {
      const resolvedPath: string = filePath;
      const fileExists = existsSync(resolvedPath);
      template.push({
        label: "Show in folder",
        enabled: fileExists,
        click: () => shell.showItemInFolder(resolvedPath),
      });
      template.push({
        label: "Open file",
        enabled: fileExists,
        click: () => void shell.openPath(resolvedPath),
      });
      template.push({
        label: "Copy path",
        click: () => clipboard.writeText(resolvedPath),
      });
    } else if (/^https?:\/\//i.test(params.linkURL)) {
      template.push({
        label: `Open in browser`,
        click: () => void shell.openExternal(params.linkURL),
      });
      template.push({
        label: `Copy link address`,
        click: () => clipboard.writeText(params.linkURL),
      });
    }

    appendTextItems(template, params, win);
    Menu.buildFromTemplate(template).popup({ window: win });
  });
}

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

  setupContextMenu(win);

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
