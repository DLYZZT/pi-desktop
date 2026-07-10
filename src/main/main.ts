/**
 * Pi Agent Desktop v2 — Electron main process
 * Responsibilities: window lifecycle, menus, tray/badge, deep link,
 * Host supervision, system IPC. No business logic.
 */
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  nativeTheme,
  Notification,
  shell,
} from "electron";
import path from "path";
import { HostManager, resolveHostEntry, resolvePreloadPath, resolveRendererEntry } from "./host-manager";
import { appendMainLog, getMainLogPath } from "./logger";
import { installAppMenu } from "./menu";
import { handleAppProtocol, registerAppProtocol, rendererRootPath } from "./protocol";
import { acquireSingleInstanceLock } from "./single-instance";
import { applyWindowBounds, loadUiState, saveUiState, shouldMaximize, trackWindowState } from "./window-state";
import { createTray, destroyTray, setTrayRunningCount } from "./tray";
import { exportDiagnostics } from "./diagnostics";

// Must run before app ready
registerAppProtocol();

const BACKGROUND = "#f7f6f3";
const isDev = !app.isPackaged;

let mainWindow: BrowserWindow | null = null;
let hostManager: HostManager | null = null;
let isQuitting = false;
let unreadBadge = 0;
let pendingDeepLink: string | null = null;

function getMainWindow(): BrowserWindow | null {
  return mainWindow;
}

function parseDeepLink(url: string): { sessionId?: string } | null {
  try {
    const u = new URL(url);
    if (u.protocol !== "pi-agent-desktop:") return null;
    // pi-agent-desktop://session/<id>
    if (u.hostname === "session" || u.pathname.startsWith("/session/")) {
      const id =
        u.hostname === "session"
          ? u.pathname.replace(/^\//, "")
          : u.pathname.replace(/^\/session\//, "");
      return id ? { sessionId: id } : null;
    }
  } catch {
    /* ignore */
  }
  return null;
}

function handleDeepLink(url: string): void {
  appendMainLog(`deep link: ${url}`);
  const parsed = parseDeepLink(url);
  if (!parsed?.sessionId) return;
  const win = getMainWindow();
  if (win) {
    win.webContents.send("deep-link:session", parsed.sessionId);
    win.show();
    win.focus();
  } else {
    pendingDeepLink = parsed.sessionId;
  }
}

if (!acquireSingleInstanceLock(getMainWindow, (argv) => {
  const url = argv.find((a) => a.startsWith("pi-agent-desktop://"));
  if (url) handleDeepLink(url);
})) {
  app.quit();
}

app.on("open-url", (event, url) => {
  event.preventDefault();
  handleDeepLink(url);
});

function createWindow(): BrowserWindow {
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
      preload: resolvePreloadPath(),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    },
  });

  mainWindow = win;
  trackWindowState(win);
  if (shouldMaximize(ui) && !win.isDestroyed()) {
    win.maximize();
  }

  const showWin = () => {
    if (!win.isDestroyed() && !win.isVisible()) {
      win.show();
      if (isDev || process.env.PI_DESKTOP_DEVTOOLS === "1") {
        win.webContents.openDevTools({ mode: "detach" });
      }
    }
  };
  win.once("ready-to-show", showWin);
  setTimeout(showWin, 3_000);

  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url) || /^mailto:/i.test(url)) {
      void shell.openExternal(url);
    }
    return { action: "deny" };
  });

  win.webContents.on("will-navigate", (event, url) => {
    const allowed =
      url.startsWith("app://") ||
      url.startsWith("http://localhost:5173") ||
      url.startsWith("http://127.0.0.1:5173");
    if (!allowed) {
      event.preventDefault();
      if (/^https?:/i.test(url)) void shell.openExternal(url);
    }
  });

  win.on("close", (e) => {
    if (process.platform === "darwin" && !isQuitting) {
      e.preventDefault();
      win.hide();
    }
  });

  win.on("closed", () => {
    if (mainWindow === win) mainWindow = null;
  });

  win.webContents.on("render-process-gone", (_e, details) => {
    appendMainLog(`render-process-gone: ${details.reason}`);
    if (!win.isDestroyed()) win.reload();
  });

  // Connect renderer ↔ Host via MessagePort after DOM ready
  win.webContents.on("did-finish-load", () => {
    if (pendingDeepLink) {
      win.webContents.send("deep-link:session", pendingDeepLink);
      pendingDeepLink = null;
    }
  });

  win.webContents.on("did-fail-load", (_e, code, desc, validatedURL, isMainFrame) => {
    if (!isMainFrame || code === -3) return;
    appendMainLog(`did-fail-load code=${code} desc=${desc} url=${validatedURL}`);
    const help =
      `<!DOCTYPE html><html><body style="font-family:system-ui;background:#f7f6f3;padding:40px;color:#1c1a17">` +
      `<h1 style="font-family:ui-monospace,monospace;font-size:18px">Cannot load UI</h1>` +
      `<p style="color:#57534a;font-size:13.5px;line-height:1.55">Failed to load <code>${validatedURL || url}</code><br/>Error ${code}: ${desc}</p>` +
      `<p style="color:#57534a;font-size:13.5px">Try: <code>npm run build && npm start</code> or <code>npm run dev</code></p>` +
      `</body></html>`;
    void win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(help)}`);
  });

  win.webContents.on("console-message", (_e, level, message, line, sourceId) => {
    if (level >= 2) {
      appendMainLog(`renderer[${level}] ${message} (${sourceId}:${line})`);
    }
  });

  const url = resolveRendererEntry(isDev);
  appendMainLog(`loadURL ${url}`);
  void win.loadURL(url);

  return win;
}

function installIpc(): void {
  ipcMain.handle("desktop:get-version", () => app.getVersion());

  ipcMain.handle("desktop:get-host-status", () => hostManager?.getStatus() ?? "stopped");

  ipcMain.on("desktop:connect-host", (event) => {
    if (!hostManager) return;
    const { port1 } = hostManager.createRendererChannel();
    event.sender.postMessage("desktop:host-port", null, [port1]);
  });

  ipcMain.handle("desktop:open-external", async (_e, url: string) => {
    if (typeof url !== "string") return;
    if (!/^(https?:|mailto:)/i.test(url)) {
      throw new Error("Blocked non-http(s)/mailto URL");
    }
    await shell.openExternal(url);
  });

  ipcMain.handle("desktop:show-item-in-folder", async (_e, fsPath: string) => {
    if (typeof fsPath !== "string") return;
    shell.showItemInFolder(fsPath);
  });

  ipcMain.handle("desktop:select-directory", async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    const ui = loadUiState();
    const result = await dialog.showOpenDialog(win ?? undefined!, {
      properties: ["openDirectory", "createDirectory"],
      defaultPath: ui.recentCwds?.[0],
    });
    if (result.canceled || !result.filePaths[0]) return null;
    const dir = result.filePaths[0];
    const recent = [dir, ...(ui.recentCwds ?? []).filter((p) => p !== dir)].slice(0, 12);
    saveUiState({ recentCwds: recent });
    return dir;
  });

  ipcMain.handle(
    "desktop:save-file",
    async (event, opts: { content: string; defaultPath?: string; filters?: Electron.FileFilter[] }) => {
      const win = BrowserWindow.fromWebContents(event.sender);
      const result = await dialog.showSaveDialog(win ?? undefined!, {
        defaultPath: opts.defaultPath,
        filters: opts.filters ?? [{ name: "Markdown", extensions: ["md"] }],
      });
      if (result.canceled || !result.filePath) return null;
      const fs = await import("fs");
      fs.writeFileSync(result.filePath, opts.content, "utf8");
      return result.filePath;
    },
  );

  ipcMain.on("desktop:notify-agent-end", (_e, payload: { sessionId: string; title?: string }) => {
    if (!Notification.isSupported()) return;
    const n = new Notification({
      title: payload.title || "Agent finished",
      body: "Session completed",
    });
    n.on("click", () => {
      const win = getMainWindow();
      if (win) {
        win.show();
        win.focus();
        win.webContents.send("deep-link:session", payload.sessionId);
      }
    });
    n.show();
    unreadBadge += 1;
    app.setBadgeCount(unreadBadge);
  });

  ipcMain.on("desktop:set-badge-count", (_e, n: number) => {
    unreadBadge = Math.max(0, Number(n) || 0);
    app.setBadgeCount(unreadBadge);
  });

  ipcMain.handle("desktop:get-ui-state", () => loadUiState());
  ipcMain.handle("desktop:set-ui-state", (_e, patch: Record<string, unknown>) => {
    saveUiState(patch);
  });

  ipcMain.handle("desktop:get-theme-source", () => nativeTheme.themeSource);
  ipcMain.handle("desktop:set-theme-source", (_e, source: "system" | "light" | "dark") => {
    nativeTheme.themeSource = source;
    saveUiState({ theme: source });
  });

  ipcMain.handle("desktop:open-logs", () => {
    shell.showItemInFolder(getMainLogPath());
  });

  ipcMain.handle("desktop:export-diagnostics", async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    return exportDiagnostics(win);
  });

  ipcMain.handle("desktop:clear-badge", () => {
    unreadBadge = 0;
    app.setBadgeCount(0);
  });
}

app.whenReady().then(() => {
  appendMainLog(`app ready packaged=${app.isPackaged}`);

  // Always register app:// so we can load the built renderer without Vite
  // (npm start after build, or dev fallback when VITE_DEV_SERVER_URL is unset).
  handleAppProtocol(rendererRootPath());

  installIpc();
  installAppMenu(getMainWindow);

  if (process.env.PI_SMOKE_TEST !== "1") {
    createTray(getMainWindow);
  }

  // Apply persisted theme preference
  const ui = loadUiState();
  if (ui.theme === "light" || ui.theme === "dark" || ui.theme === "system") {
    nativeTheme.themeSource = ui.theme;
  }

  hostManager = new HostManager(resolveHostEntry());
  hostManager.setStatusListener((status, detail) => {
    appendMainLog(`host status=${status} ${detail ?? ""}`);
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.send("host:status", { status, detail });
      if (status === "ready" && detail?.includes("restart")) {
        win.webContents.send("host:restarted", { reason: detail });
      }
      if (status === "crashed") {
        win.webContents.send("host:crashed", { detail });
      }
    }
    if (process.env.PI_SMOKE_TEST === "1" && status === "ready") {
      appendMainLog("smoke: host ready — exiting 0");
      setTimeout(() => {
        isQuitting = true;
        hostManager?.stop();
        app.exit(0);
      }, 500);
    }
    if (process.env.PI_SMOKE_TEST === "1" && status === "crashed") {
      appendMainLog(`smoke: host crashed — ${detail}`);
      app.exit(1);
    }
  });

  hostManager.setMessageListener((msg) => {
    if (msg.type === "running-sessions") {
      const ids = (msg.sessionIds as string[]) ?? [];
      setTrayRunningCount(ids.length, getMainWindow);
    } else if (msg.type === "agent-end") {
      const sessionId = String(msg.sessionId ?? "");
      // Notify if no focused window or window is hidden (desktop value-add)
      const win = getMainWindow();
      const shouldNotify = !win || !win.isVisible() || !win.isFocused();
      if (shouldNotify && Notification.isSupported() && sessionId) {
        const n = new Notification({
          title: "Agent finished",
          body: "A session completed in the background",
        });
        n.on("click", () => {
          const w = getMainWindow();
          if (w) {
            w.show();
            w.focus();
            w.webContents.send("deep-link:session", sessionId);
          }
        });
        n.show();
        unreadBadge += 1;
        app.setBadgeCount(unreadBadge);
      }
    } else if (msg.type === "host-restarted") {
      for (const win of BrowserWindow.getAllWindows()) {
        win.webContents.send("host:restarted", { reason: String(msg.reason ?? "restart") });
      }
    }
  });

  hostManager.start();

  if (process.env.PI_SMOKE_TEST !== "1") {
    createWindow();
  }

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    } else {
      getMainWindow()?.show();
    }
  });
});

app.on("before-quit", () => {
  isQuitting = true;
  destroyTray();
  hostManager?.stop();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

// Deep link registration
if (process.defaultApp) {
  if (process.argv.length >= 2) {
    app.setAsDefaultProtocolClient("pi-agent-desktop", process.execPath, [
      path.resolve(process.argv[1]),
    ]);
  }
} else {
  app.setAsDefaultProtocolClient("pi-agent-desktop");
}
