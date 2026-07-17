/**
 * Pi Agent Desktop v2 — Electron main process
 * Responsibilities: window lifecycle, menus, tray/badge, deep link,
 * Host supervision, system IPC. No business logic.
 */
import { app, BrowserWindow, crashReporter, nativeTheme, nativeImage, Notification } from "electron";
import path from "path";
import { HostManager, getUserDataPath, resolveHostEntry } from "./host-manager";
import { appendMainLog } from "./logger";
import { installAppMenu } from "./menu";
import { handleAppProtocol, registerAppProtocol, rendererRootPath } from "./protocol";
import { acquireSingleInstanceLock } from "./single-instance";
import { loadUiState } from "./window-state";
import { createTray, destroyTray, setTrayRunningCount } from "./tray";
import { createMainWindow } from "./window";
import { installDesktopIpc } from "./ipc";
import { createCredentialRequestHandler, CredentialVault } from "./credential-vault";
import { createProductionUpdateAdapter, isProductionUpdatePlatformEnabled } from "./update-adapter";
import { createUpdateManager, redactUpdateError, type UpdateManager } from "./update-manager";

// Must run before app ready
registerAppProtocol();
crashReporter.start({
  productName: "Pi Agent Desktop",
  uploadToServer: false,
  compress: false,
});

const isDev = !app.isPackaged;

let mainWindow: BrowserWindow | null = null;
let hostManager: HostManager | null = null;
let updateManager: UpdateManager | null = null;
let isQuitting = false;
let unreadBadge = 0;
let pendingDeepLink: string | null = null;
let lastNotifiedUpdateVersion: string | null = null;

function getMainWindow(): BrowserWindow | null {
  return mainWindow;
}

function applyBadgeCount(count: number): void {
  unreadBadge = Math.max(0, Number(count) || 0);
  if (process.platform === "win32") {
    const win = getMainWindow();
    if (!win || win.isDestroyed()) return;
    if (unreadBadge === 0) {
      win.setOverlayIcon(null, "No unread completed sessions");
      return;
    }
    const overlay = nativeImage
      .createFromPath(path.join(app.getAppPath(), "build", "icon.png"))
      .resize({ width: 16, height: 16 });
    win.setOverlayIcon(overlay, `${unreadBadge} unread completed session${unreadBadge === 1 ? "" : "s"}`);
    return;
  }
  app.setBadgeCount(unreadBadge);
}

function parseDeepLink(url: string): { sessionId?: string } | null {
  try {
    const u = new URL(url);
    if (u.protocol !== "pi-agent-desktop:") return null;
    // pi-agent-desktop://session/<id>
    if (u.hostname === "session" || u.pathname.startsWith("/session/")) {
      const id = u.hostname === "session" ? u.pathname.replace(/^\//, "") : u.pathname.replace(/^\/session\//, "");
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

if (
  !acquireSingleInstanceLock(getMainWindow, (argv) => {
    const url = argv.find((a) => a.startsWith("pi-agent-desktop://"));
    if (url) handleDeepLink(url);
  })
) {
  app.quit();
}

app.on("open-url", (event, url) => {
  event.preventDefault();
  handleDeepLink(url);
});

function createWindow(): BrowserWindow {
  const win = createMainWindow({
    isDev,
    consumePendingDeepLink: () => {
      const sessionId = pendingDeepLink;
      pendingDeepLink = null;
      return sessionId;
    },
    shouldHideOnClose: () => !isQuitting && loadUiState().backgroundMode !== false,
    onClosed: (closedWindow) => {
      if (mainWindow === closedWindow) mainWindow = null;
    },
  });
  mainWindow = win;
  if (unreadBadge > 0) applyBadgeCount(unreadBadge);
  return win;
}

function openUpdateSettings(checkForUpdates: boolean): void {
  const win = getMainWindow() ?? createWindow();
  win.show();
  win.focus();
  const send = () => {
    if (!win.isDestroyed()) {
      win.webContents.send(checkForUpdates ? "menu:check-for-updates" : "menu:show-update");
    }
  };
  if (win.webContents.isLoadingMainFrame()) {
    win.webContents.once("did-finish-load", send);
  } else {
    send();
  }
}

void app.whenReady().then(async () => {
  appendMainLog(`app ready packaged=${app.isPackaged}`);

  const credentialVault = new CredentialVault(getUserDataPath("channels.secrets.json"));
  const ui = loadUiState();
  const updaterTestMode = !app.isPackaged && process.env.PI_DESKTOP_TEST_UPDATER === "1";
  const updaterSupported =
    isProductionUpdatePlatformEnabled(process.platform) ||
    (updaterTestMode && (process.platform === "darwin" || process.platform === "win32"));
  const updaterRequested = app.isPackaged || updaterTestMode;
  let updateAdapter = null;
  if (updaterSupported && updaterRequested) {
    try {
      updateAdapter = await createProductionUpdateAdapter({
        useDevelopmentConfig: updaterTestMode,
      });
    } catch (error) {
      appendMainLog(`updater unavailable: ${redactUpdateError(error)}`);
    }
  }
  updateManager = createUpdateManager({
    adapter: updateAdapter,
    currentVersion: app.getVersion(),
    isPackaged: app.isPackaged,
    automaticChecksEnabled: ui.automaticUpdateChecks !== false,
    prepareToInstall: () => {
      isQuitting = true;
      destroyTray();
      hostManager?.stop();
    },
    recoverFromInstallFailure: () => {
      isQuitting = false;
      createTray(getMainWindow);
      const manager = hostManager;
      if (manager) {
        let remainingAttempts = 12;
        const restartHost = () => {
          if (isQuitting) return;
          manager.start();
          if (manager.getStatus() === "stopped" && remainingAttempts-- > 0) {
            const restartTimer = setTimeout(restartHost, 250);
            restartTimer.unref();
          }
        };
        restartHost();
      }
    },
    log: (level, message) => appendMainLog(`updater[${level}] ${message}`),
  });
  updateManager.subscribe((state) => {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) win.webContents.send("update:state", state);
    }
    if (state.phase === "available") {
      const notificationKey = state.availableVersion ?? "unknown";
      if (lastNotifiedUpdateVersion !== notificationKey) {
        lastNotifiedUpdateVersion = notificationKey;
        const win = getMainWindow();
        const shouldNotify = !win || !win.isVisible() || !win.isFocused();
        if (shouldNotify && Notification.isSupported()) {
          const notification = new Notification({
            title: "Pi Agent Desktop update available",
            body: state.availableVersion
              ? `Version ${state.availableVersion} is ready to download.`
              : "A new version is ready to download.",
          });
          notification.on("click", () => {
            openUpdateSettings(false);
          });
          notification.show();
        }
      }
    }
  });

  // Always register app:// so we can load the built renderer without Vite
  // (npm start after build, or dev fallback when VITE_DEV_SERVER_URL is unset).
  handleAppProtocol(rendererRootPath());

  installDesktopIpc({
    getHostManager: () => hostManager,
    getMainWindow,
    getUnreadBadge: () => unreadBadge,
    applyBadgeCount,
    setChannelCredential: (payload) =>
      credentialVault.set(`channel:${payload.channel}:${payload.accountId}`, payload.credential),
    updateManager,
  });
  installAppMenu(getMainWindow, () => openUpdateSettings(true));

  createTray(getMainWindow);

  // Apply persisted theme preference
  if (ui.theme === "light" || ui.theme === "dark" || ui.theme === "system") {
    nativeTheme.themeSource = ui.theme;
  }

  hostManager = new HostManager(resolveHostEntry());
  hostManager.setRequestHandler(createCredentialRequestHandler(credentialVault));
  hostManager.setStatusListener((status, detail) => {
    appendMainLog(`host status=${status} ${detail ?? ""}`);
    if (status !== "ready") {
      setTrayRunningCount(0, getMainWindow);
      updateManager?.setRunningSessionCount(0);
    }
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.send("host:status", { status, detail });
      if (status === "ready" && detail?.includes("restart")) {
        win.webContents.send("host:restarted", { reason: detail });
      }
      if (status === "crashed") {
        win.webContents.send("host:crashed", { detail });
      }
    }
  });

  hostManager.setMessageListener((msg) => {
    if (msg.type === "running-sessions") {
      const ids = (msg.sessionIds as string[]) ?? [];
      setTrayRunningCount(ids.length, getMainWindow);
      updateManager?.setRunningSessionCount(ids.length);
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
        applyBadgeCount(unreadBadge + 1);
      }
    } else if (msg.type === "host-restarted") {
      for (const win of BrowserWindow.getAllWindows()) {
        win.webContents.send("host:restarted", { reason: String(msg.reason ?? "restart") });
      }
    }
  });

  hostManager.start();

  createWindow();
  updateManager.startAutomaticChecks();

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
  updateManager?.stopAutomaticChecks();
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
    app.setAsDefaultProtocolClient("pi-agent-desktop", process.execPath, [path.resolve(process.argv[1])]);
  }
} else {
  app.setAsDefaultProtocolClient("pi-agent-desktop");
}
