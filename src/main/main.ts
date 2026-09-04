/**
 * Pi Agent Desktop v2 — Electron main process
 * Responsibilities: window lifecycle, menus, tray/badge, deep link,
 * Host supervision, system IPC. No business logic.
 */
import { app, BrowserWindow, crashReporter, dialog, nativeTheme, nativeImage, net, Notification } from "electron";
import fs from "node:fs";
import os from "node:os";
import path from "path";
import { HostManager, getUserDataPath, resolveHostEntry } from "./host-manager";
import { appendMainLog } from "./logger";
import { installAppMenu } from "./menu";
import { handleAppProtocol, registerAppProtocol, rendererRootPath } from "./protocol";
import { acquireSingleInstanceLock } from "./single-instance";
import { loadUiState, saveUiStateStrict } from "./window-state";
import { createTray, destroyTray, setTrayManagedProcessCount, setTrayRunningCount } from "./tray";
import { createMainWindow } from "./window";
import { installDesktopIpc } from "./ipc";
import { createCredentialRequestHandler, CredentialVault } from "./credential-vault";
import { createProductionUpdateAdapter, isProductionUpdatePlatformEnabled } from "./update-adapter";
import { createUpdateManager, redactUpdateError, type UpdateManager } from "./update-manager";
import { ToolchainManager } from "./toolchains/manager";
import { resolveRuntimeCatalogPath } from "./toolchains/catalog";
import { resolveBundledCorePaths } from "./toolchains/bundled-core";
import { isExecutionIntent, type ToolchainSnapshot } from "../shared/toolchains/types";
import { readLegacyNpmCommand } from "./toolchains/legacy-npm-command";
import { createElectronRuntimeFetch } from "./toolchains/electron-runtime-fetch";
import { BrowserService } from "./browser/browser-service";
import { findDesktopDeepLink, parseDesktopDeepLink } from "./deep-link";
import { restartHostAfterExit } from "./host-install-recovery";
import { ManagedProcessReaper, secureWindowsReaperDirectory } from "./managed-process/reaper";
import { beforeDeadline, cleanupManagedProcessContainment } from "./managed-process/shutdown-cleanup";
import {
  resolveWindowsManagedProcessHelper,
  type WindowsManagedProcessHelperResolution,
  verifyWindowsManagedProcessHelperReplaceable,
} from "../shared/windows-managed-process-helper";
import type { ManagedProcessCapability } from "../contract/processes";
import { projectManagedProcessCapability } from "./managed-process/capability";
import { runPackagedCleanupFaultValidation } from "./packaged-cleanup-fault-validation";
import { HerdrRuntimeManager } from "./herdr/runtime-manager";
import { resolveBundledHerdrRoot, resolveHerdrCatalogPath } from "./herdr/catalog";
import { isHerdrSettings } from "../contract/herdr";
import { discoverHerdrAgentClis, type HerdrAgentCliDiscoverySnapshot } from "./herdr/agent-cli-discovery";

// Must run before app ready
registerAppProtocol();
crashReporter.start({
  productName: "Pi Agent Desktop",
  uploadToServer: false,
  compress: false,
});

const isDev = !app.isPackaged;
const packagedStartupValidation = app.isPackaged && process.argv.includes("--validate-packaged-startup");
const packagedCleanupFaultValidation = app.isPackaged && process.argv.includes("--validate-packaged-cleanup-fault");
const expectedPiVersion = process.env.PI_DESKTOP_EXPECTED_PI_VERSION;
const TOOLCHAIN_FOCUS_RESCAN_TTL_MS = 60_000;
const MANAGED_PROCESS_SHUTDOWN_DEADLINE_MS = 15_000;

let mainWindow: BrowserWindow | null = null;
let hostManager: HostManager | null = null;
let updateManager: UpdateManager | null = null;
let toolchainManager: ToolchainManager | null = null;
let browserService: BrowserService | null = null;
let managedProcessReaper: ManagedProcessReaper | null = null;
let windowsManagedProcessHelper: WindowsManagedProcessHelperResolution | null = null;
let herdrRuntimeManager: HerdrRuntimeManager | null = null;
let herdrAgentCliDiscovery: HerdrAgentCliDiscoverySnapshot | null = null;
let isQuitting = false;
let unreadBadge = 0;
let pendingDeepLink: string | null = null;
let lastNotifiedUpdateVersion: string | null = null;
let lastToolchainFocusScanAt = 0;
let runningAgentSessionCount = 0;
let runningManagedProcessCount = 0;
let startupRendererReady = false;
let startupHostReady = false;
let startupToolchainSnapshot: ToolchainSnapshot | null = null;
let startupCheckFinished = false;
let startupCheckTimer: ReturnType<typeof setTimeout> | null = null;
let quitCleanupStarted = false;
let quitCleanupComplete = false;

async function refreshHerdrAgentCliDiscovery(): Promise<void> {
  try {
    const snapshot = await discoverHerdrAgentClis({
      homeDir: app.getPath("home"),
      userDataDir: app.getPath("userData"),
      platform: process.platform,
      env: process.env,
    });
    const changed = snapshot.revision !== herdrAgentCliDiscovery?.revision;
    herdrAgentCliDiscovery = snapshot;
    const detected = snapshot.diagnostics.filter((entry) => entry.available).length;
    const ambiguous = snapshot.diagnostics.filter((entry) => entry.status === "ambiguous").length;
    appendMainLog(
      `agent-cli scan revision=${snapshot.revision} detected=${detected} missing=${snapshot.diagnostics.length - detected} ambiguous=${ambiguous}`,
    );
    if (changed && herdrRuntimeManager) await herdrRuntimeManager.refresh();
  } catch {
    appendMainLog("agent-cli scan failed");
  }
}

function getManagedProcessCapability(): ManagedProcessCapability {
  const status = managedProcessReaper?.status();
  const owner = hostManager?.getManagedProcessOwnerState();
  return projectManagedProcessCapability({
    platform: process.platform,
    arch: process.arch,
    reaperReady: status?.ready === true,
    helper: windowsManagedProcessHelper,
    ownerReady: owner?.ready === true && Boolean(owner.hostInstanceId),
    windowsRelease: os.release(),
    windowsVersion: os.version(),
  });
}

async function cleanupManagedProcesses(deadline: number, requireConfirmedEmpty: boolean): Promise<void> {
  await cleanupManagedProcessContainment({
    deadline,
    requireConfirmedEmpty,
    stopHost: () => hostManager?.stop() ?? Promise.resolve(),
    ...(managedProcessReaper
      ? {
          reapAll: () => managedProcessReaper!.reapAll(),
          getStatus: () => managedProcessReaper!.status(),
        }
      : {}),
    log: appendMainLog,
  });
}

function finishPackagedStartupValidation(error?: string): void {
  if (!packagedStartupValidation || startupCheckFinished) return;
  if (!error) {
    const snapshot = startupToolchainSnapshot;
    if (!startupRendererReady || !startupHostReady || !snapshot?.publicState.coreReady) return;
    if (!expectedPiVersion || hostManager?.getPiVersion() !== expectedPiVersion) {
      error = `Agent Host Pi version mismatch: expected ${expectedPiVersion ?? "unknown"}, got ${hostManager?.getPiVersion() ?? "unknown"}`;
    }
    if ((hostManager?.getToolchainAckRevision() ?? -1) < snapshot.revision) return;
    for (const capability of ["search.rg", "search.fd"] as const) {
      const candidates = snapshot.publicState.capabilities[capability]?.candidates ?? [];
      if (!candidates.some((candidate) => candidate.provider === "bundled" && candidate.health === "healthy")) return;
    }
  }

  startupCheckFinished = true;
  if (startupCheckTimer) clearTimeout(startupCheckTimer);
  try {
    const report = error
      ? { ok: false, error }
      : {
          ok: true,
          appVersion: app.getVersion(),
          piVersion: hostManager?.getPiVersion(),
          platformArch: `${process.platform}-${process.arch}`,
          revision: startupToolchainSnapshot?.revision,
          rendererReady: startupRendererReady,
          hostReady: startupHostReady,
          hostAckRevision: hostManager?.getToolchainAckRevision(),
          bundledSearch: ["search.rg", "search.fd"],
        };
    fs.mkdirSync(app.getPath("userData"), { recursive: true, mode: 0o700 });
    fs.writeFileSync(
      path.join(app.getPath("userData"), "packaged-startup-check.json"),
      `${JSON.stringify(report, null, 2)}\n`,
      { encoding: "utf8", mode: 0o600 },
    );
  } catch (writeError) {
    error ??= writeError instanceof Error ? writeError.message : "Could not write packaged startup report";
  }
  isQuitting = true;
  updateManager?.stopAutomaticChecks();
  const exitCode = error ? 1 : 0;
  void (async () => {
    try {
      // The packaged probe exits immediately after startup. Let the utility
      // process release the packaged resources before Electron shuts down so
      // AppImage extraction mode can reap the temporary application cleanly.
      await hostManager?.stop();
    } catch (stopError) {
      appendMainLog(
        `packaged startup host shutdown failed: ${stopError instanceof Error ? stopError.message : String(stopError)}`,
      );
    } finally {
      for (const win of BrowserWindow.getAllWindows()) win.destroy();
      app.exit(exitCode);
    }
  })();
}

function getMainWindow(): BrowserWindow | null {
  return mainWindow;
}

function managedProcessDialogCopy(): {
  stopAllTitle: string;
  stopAllMessage: (count: number) => string;
  stopAllDetail: string;
  stopAllButton: string;
  cancelButton: string;
  lanTitle: string;
  lanMessage: string;
  lanDetail: string;
  allowOnceButton: string;
  exportTitle: string;
  exportFilter: string;
  quitTitle: string;
  quitMessage: (count: number) => string;
  quitDetail: string;
  stopAndQuitButton: string;
} {
  if (app.getLocale().toLowerCase().startsWith("zh")) {
    return {
      stopAllTitle: "停止后台进程",
      stopAllMessage: (count) => `确认停止 ${count} 个受管后台进程？`,
      stopAllDetail: "开发服务器和 watcher 将连同完整进程树一起停止。",
      stopAllButton: "全部停止",
      cancelButton: "取消",
      lanTitle: "允许绑定局域网？",
      lanMessage: "Agent 命令似乎会把受管进程绑定到所有网络接口。",
      lanDetail: "这可能把开发服务器暴露给局域网内的其他设备。除非确实需要局域网访问，否则请使用 127.0.0.1。",
      allowOnceButton: "仅允许本次",
      exportTitle: "导出受管进程日志",
      exportFilter: "日志文件",
      quitTitle: "退出 Pi Agent Desktop",
      quitMessage: (count) => `仍有 ${count} 个受管后台进程在运行。`,
      quitDetail: "退出会停止所有开发服务器和 watcher，并清理其完整进程树。",
      stopAndQuitButton: "停止并退出",
    };
  }
  return {
    stopAllTitle: "Stop background processes",
    stopAllMessage: (count) => `Stop ${count} managed background process${count === 1 ? "" : "es"}?`,
    stopAllDetail: "Development servers and watchers will be stopped with their complete process trees.",
    stopAllButton: "Stop All",
    cancelButton: "Cancel",
    lanTitle: "Allow local-network binding?",
    lanMessage: "An Agent command appears to bind a managed process to all network interfaces.",
    lanDetail:
      "This may expose the development server to other devices on the local network. Prefer 127.0.0.1 unless LAN access is intentional.",
    allowOnceButton: "Allow Once",
    exportTitle: "Export managed process log",
    exportFilter: "Log files",
    quitTitle: "Quit Pi Agent Desktop",
    quitMessage: (count) => `${count} managed background process${count === 1 ? " is" : "es are"} still running.`,
    quitDetail: "Quitting stops every development server and watcher with its complete process tree.",
    stopAndQuitButton: "Stop and Quit",
  };
}

async function stopAllManagedProcessesFromTray(): Promise<void> {
  if (runningManagedProcessCount <= 0 || hostManager?.getStatus() !== "ready") return;
  const window = getMainWindow();
  const copy = managedProcessDialogCopy();
  const options = {
    type: "warning" as const,
    title: copy.stopAllTitle,
    message: copy.stopAllMessage(runningManagedProcessCount),
    detail: copy.stopAllDetail,
    buttons: [copy.stopAllButton, copy.cancelButton],
    defaultId: 1,
    cancelId: 1,
    noLink: true,
  };
  const result = window ? await dialog.showMessageBox(window, options) : await dialog.showMessageBox(options);
  if (result.response !== 0) return;
  try {
    await hostManager.call("processes.stopAll", { mode: "graceful" }, 15_000);
  } catch (error) {
    appendMainLog(`stop all managed processes failed: ${error instanceof Error ? error.message : String(error)}`);
  }
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

function handleDeepLink(url: string): void {
  const parsed = parseDesktopDeepLink(url);
  appendMainLog(`deep link received valid=${Boolean(parsed?.sessionId)}`);
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

function startMainProcess(): void {
  if (
    !acquireSingleInstanceLock(getMainWindow, (argv) => {
      const url = findDesktopDeepLink(argv);
      if (url) handleDeepLink(url);
    })
  ) {
    app.quit();
    return;
  }

  app.on("open-url", (event, url) => {
    event.preventDefault();
    handleDeepLink(url);
  });

  app.on("login", (event, webContents, _details, authInfo, callback) => {
    const credentials = browserService?.getProxyCredentialsForWebContents(webContents.id, authInfo.isProxy);
    if (!credentials) return;
    event.preventDefault();
    callback(credentials.username, credentials.password);
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
        if (mainWindow === closedWindow) {
          mainWindow = null;
          browserService?.handleWindowClosed();
        }
      },
      onRendererUnavailable: () => browserService?.handleRendererUnavailable(),
    });
    mainWindow = win;
    win.on("hide", () => browserService?.handleWindowVisibility(false));
    win.on("minimize", () => browserService?.handleWindowVisibility(false));
    win.on("show", () => browserService?.handleWindowVisibility(true));
    win.on("restore", () => browserService?.handleWindowVisibility(true));
    win.on("focus", () => {
      const manager = toolchainManager;
      const now = Date.now();
      if (!manager || now - lastToolchainFocusScanAt < TOOLCHAIN_FOCUS_RESCAN_TTL_MS) return;
      lastToolchainFocusScanAt = now;
      void manager.rescan().catch((error) => {
        appendMainLog(`toolchain focus rescan failed: ${error instanceof Error ? error.message : String(error)}`);
      });
    });
    if (packagedStartupValidation) {
      win.webContents.once("did-finish-load", () => {
        startupRendererReady = true;
        finishPackagedStartupValidation();
      });
      win.webContents.once("did-fail-load", (_event, code, description) => {
        finishPackagedStartupValidation(`Renderer failed to load (${code}): ${description}`);
      });
    }
    if (unreadBadge > 0) applyBadgeCount(unreadBadge);
    void browserService?.restoreTabs();
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
    if (packagedCleanupFaultValidation) {
      let exitCode = 0;
      try {
        const report = await runPackagedCleanupFaultValidation({
          productionDeadlineMs: MANAGED_PROCESS_SHUTDOWN_DEADLINE_MS,
        });
        fs.mkdirSync(app.getPath("userData"), { recursive: true, mode: 0o700 });
        fs.writeFileSync(
          path.join(app.getPath("userData"), "packaged-cleanup-fault-check.json"),
          `${JSON.stringify(report, null, 2)}\n`,
          { encoding: "utf8", mode: 0o600 },
        );
        if (!report.ok) exitCode = 1;
      } catch (error) {
        exitCode = 1;
        appendMainLog(`packaged cleanup fault validation failed: ${error instanceof Error ? error.name : "unknown"}`);
      }
      isQuitting = true;
      quitCleanupComplete = true;
      app.exit(exitCode);
      return;
    }
    if (process.platform === "win32" && process.arch === "x64") {
      windowsManagedProcessHelper = resolveWindowsManagedProcessHelper({
        isPackaged: app.isPackaged,
        resourcesPath: process.resourcesPath,
        projectRoot: path.resolve(__dirname, "../.."),
      });
      appendMainLog(
        windowsManagedProcessHelper.ok
          ? `windows managed process helper verified build=${windowsManagedProcessHelper.descriptor.buildId} provenance=${windowsManagedProcessHelper.descriptor.provenance}`
          : `windows managed process helper unavailable error=${windowsManagedProcessHelper.errorCode}`,
      );
    }
    const reaperDirectory = path.join(app.getPath("userData"), "managed-process-reaper");
    const windowsJournalSecured =
      process.platform !== "win32" ||
      Boolean(
        windowsManagedProcessHelper?.ok &&
        (await secureWindowsReaperDirectory(reaperDirectory, windowsManagedProcessHelper.descriptor, appendMainLog)),
      );
    managedProcessReaper = new ManagedProcessReaper(path.join(reaperDirectory, "journal-v2.json"), {
      log: appendMainLog,
      ...(windowsManagedProcessHelper?.ok && windowsJournalSecured
        ? { windowsHelper: windowsManagedProcessHelper.descriptor }
        : {}),
    });
    const reaperStatus = await managedProcessReaper.initialize();
    appendMainLog(
      `managed process reaper ready=${reaperStatus.ready} records=${reaperStatus.records} revision=${reaperStatus.revision}${reaperStatus.errorCode ? ` error=${reaperStatus.errorCode}` : ""}`,
    );
    if (packagedStartupValidation) {
      startupCheckTimer = setTimeout(
        () => finishPackagedStartupValidation("Packaged startup validation timed out"),
        45_000,
      );
    }

    const credentialVault = new CredentialVault(getUserDataPath("channels.secrets.json"));
    browserService = new BrowserService({
      userDataDir: app.getPath("userData"),
      getWindow: getMainWindow,
      emit: (event) => {
        const win = getMainWindow();
        if (win && !win.isDestroyed()) win.webContents.send("browser:event", event);
      },
      onCapabilitySnapshot: (snapshot) => hostManager?.setBrowserCapabilitySnapshot(snapshot),
    });
    const ui = loadUiState();
    await refreshHerdrAgentCliDiscovery();
    herdrRuntimeManager = new HerdrRuntimeManager({
      userDataDir: app.getPath("userData"),
      log: (message) => appendMainLog(`herdr managed server: ${message}`),
      catalogPath: resolveHerdrCatalogPath({
        isPackaged: app.isPackaged,
        resourcesRoot: process.resourcesPath,
      }),
      bundledRoot: resolveBundledHerdrRoot({
        isPackaged: app.isPackaged,
        resourcesRoot: process.resourcesPath,
      }),
      ...(herdrAgentCliDiscovery
        ? {
            agentCliEnvironmentProvider: () => ({
              revision: herdrAgentCliDiscovery!.revision,
              diagnostics: herdrAgentCliDiscovery!.diagnostics,
              managedPath: herdrAgentCliDiscovery!.managedPath,
            }),
          }
        : {}),
    });
    herdrRuntimeManager.setListener((descriptor) => {
      hostManager?.setHerdrRuntimeDescriptor(descriptor);
      toolchainManager?.refreshManagedComponents();
    });
    void herdrRuntimeManager.initializeInBackground(ui.herdrSettings).catch(() => {
      appendMainLog("Herdr runtime initialization failed");
    });
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
      prepareToInstall: async () => {
        isQuitting = true;
        destroyTray();
        const deadline = Date.now() + MANAGED_PROCESS_SHUTDOWN_DEADLINE_MS;
        const herdrCleanup = beforeDeadline(herdrRuntimeManager?.stopManagedServer() ?? Promise.resolve(), deadline);
        await cleanupManagedProcesses(deadline, true);
        if (!(await herdrCleanup).completed) throw new Error("Managed Herdr server cleanup timed out before update");
        if (process.platform === "win32") {
          const refreshed = resolveWindowsManagedProcessHelper({
            isPackaged: app.isPackaged,
            resourcesPath: process.resourcesPath,
            projectRoot: path.resolve(__dirname, "../.."),
          });
          if (!refreshed.ok) throw new Error("Windows managed process helper is unavailable for update");
          if (!verifyWindowsManagedProcessHelperReplaceable(refreshed.descriptor)) {
            throw new Error("Windows managed process helper is locked for update");
          }
          windowsManagedProcessHelper = refreshed;
        }
      },
      recoverFromInstallFailure: async () => {
        isQuitting = false;
        createTray(getMainWindow, () => void stopAllManagedProcessesFromTray());
        const manager = hostManager;
        if (manager) await restartHostAfterExit(manager, () => !isQuitting);
        await herdrRuntimeManager?.refresh();
      },
      log: (level, message) => appendMainLog(`updater[${level}] ${message}`),
    });
    const bundledCorePaths = resolveBundledCorePaths({
      isPackaged: app.isPackaged,
      resourcesRoot: process.resourcesPath,
    });
    const toolchainHome = app.getPath("home");
    toolchainManager = new ToolchainManager({
      platform: process.platform,
      arch: process.arch,
      env: process.env,
      homeDir: toolchainHome,
      tempRoot: app.getPath("temp"),
      userDataRoot: app.getPath("userData"),
      resourcesRoot: process.resourcesPath,
      catalogPath: resolveRuntimeCatalogPath({
        isPackaged: app.isPackaged,
        resourcesRoot: process.resourcesPath,
      }),
      coreCatalogPath: bundledCorePaths.catalogPath,
      bundledCoreRoot: bundledCorePaths.coreRoot,
      // Chromium networking follows the user's system proxy/PAC and OS trust
      // configuration. Redirects are synchronously allowlisted before following.
      fetchImpl: createElectronRuntimeFetch((options) => net.request(options)),
      legacyNpmCommand: readLegacyNpmCommand({ homeDir: toolchainHome, env: process.env }),
      isRuntimeInUse: () => runningAgentSessionCount > 0,
      managedComponentLifecycles: {
        herdr: {
          getState: () => herdrRuntimeManager!.getManagedComponentState(),
          install: async (onProgress, signal) => {
            await herdrRuntimeManager!.installManagedRuntime(onProgress, signal);
          },
          remove: async () => {
            await herdrRuntimeManager!.removeManagedRuntime();
          },
        },
      },
    });
    toolchainManager.subscribe((snapshot) => {
      if (packagedStartupValidation) startupToolchainSnapshot = snapshot;
      appendMainLog(
        `toolchain scan revision=${snapshot.revision} candidates=${snapshot.candidates.length} ready=${snapshot.publicState.coreReady}`,
      );
      for (const win of BrowserWindow.getAllWindows()) {
        if (!win.isDestroyed()) win.webContents.send("toolchains:state", snapshot.publicState);
      }
      hostManager?.setToolchainSnapshot(snapshot);
      finishPackagedStartupValidation();
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
      getToolchainState: (cwd) =>
        cwd ? toolchainManager!.getPublicStateForProject(cwd) : toolchainManager!.getPublicState(),
      rescanToolchains: async (cwd) => {
        await toolchainManager!.rescan({ cwd });
        await refreshHerdrAgentCliDiscovery();
        return cwd ? toolchainManager!.getPublicStateForProject(cwd) : toolchainManager!.getPublicState();
      },
      performToolchainAction: (request) => toolchainManager!.performAction(request),
      chooseCustomTool: (capability, executable) => toolchainManager!.registerCustomTool(capability, executable),
      setChannelCredential: (payload) =>
        credentialVault.set(`channel:${payload.channel}:${payload.accountId}`, payload.credential),
      getBrowserService: () => browserService,
      getManagedProcessCapability,
      onUiStatePatch: (patch) => {
        if (patch.herdrSettings) {
          void herdrRuntimeManager!.configure(patch.herdrSettings).catch((error) => {
            appendMainLog(`Herdr settings refresh failed: ${error instanceof Error ? error.message : String(error)}`);
          });
        }
      },
      updateManager,
    });
    installAppMenu(getMainWindow, () => openUpdateSettings(true), isDev);

    createTray(getMainWindow, () => void stopAllManagedProcessesFromTray());

    // Apply persisted theme preference
    if (ui.theme === "light" || ui.theme === "dark" || ui.theme === "system") {
      nativeTheme.themeSource = ui.theme;
    }

    hostManager = new HostManager(resolveHostEntry());
    hostManager.setBeforeRestartHandler(async () => {
      const status = await managedProcessReaper!.reapAll();
      appendMainLog(
        `managed process pre-restart reap ready=${status.ready} records=${status.records}${status.errorCode ? ` error=${status.errorCode}` : ""}`,
      );
      if (!status.ready || status.records !== 0) {
        throw new Error(`Managed process cleanup blocked Host restart (${status.errorCode ?? "unknown"})`);
      }
    });
    hostManager.setToolchainSnapshot(toolchainManager.getSnapshot());
    hostManager.setBrowserCapabilitySnapshot(browserService.getCapabilitySnapshot());
    hostManager.setHerdrRuntimeDescriptor(herdrRuntimeManager.getDescriptor());
    const credentialRequestHandler = createCredentialRequestHandler(credentialVault);
    hostManager.setRequestHandler(async (method, params) => {
      if (method.startsWith("channelSecrets.")) return credentialRequestHandler(method, params);
      if (method === "toolchain.getSnapshot") return toolchainManager!.getSnapshot();
      if (method === "toolchain.resolve") {
        const body = (params ?? {}) as { cwd?: unknown; intent?: unknown; trusted?: unknown };
        if (
          typeof body.cwd !== "string" ||
          !path.isAbsolute(body.cwd) ||
          body.cwd.length > 4_096 ||
          /[\0\r\n]/.test(body.cwd) ||
          !isExecutionIntent(body.intent) ||
          typeof body.trusted !== "boolean"
        ) {
          throw new Error("Invalid Host toolchain resolution request");
        }
        return toolchainManager!.resolveForProject(body.cwd, { intent: body.intent, trusted: body.trusted });
      }
      if (method === "managedProcesses.getSettings") {
        const status = managedProcessReaper?.status();
        const capability = getManagedProcessCapability();
        return {
          enabled: capability.ready && loadUiState().managedProcessesEnabled === true,
          reaperReady: status?.ready === true,
          capability,
          ...(windowsManagedProcessHelper?.ok ? { windowsHelper: windowsManagedProcessHelper.descriptor } : {}),
        };
      }
      if (method === "herdr.configure") {
        const body = (params ?? {}) as { settings?: unknown };
        if (!isHerdrSettings(body.settings)) throw new Error("Invalid Herdr settings");
        saveUiStateStrict({ herdrSettings: body.settings });
        return herdrRuntimeManager!.configure(body.settings);
      }
      if (method === "herdr.refreshRuntime") return herdrRuntimeManager!.refresh();
      if (method === "managedProcesses.register") {
        const body = (params ?? {}) as { record?: unknown };
        const record = body.record;
        const recordPlatform =
          record && typeof record === "object" && !Array.isArray(record)
            ? (record as { platform?: unknown }).platform
            : undefined;
        if (recordPlatform === "win32") {
          const currentOwner = hostManager?.getManagedProcessOwnerState();
          const recordOwner = (record as { hostInstanceId?: unknown }).hostInstanceId;
          if (!currentOwner?.ready || recordOwner !== currentOwner.hostInstanceId) {
            throw new Error("Windows managed process register owner generation mismatch");
          }
        }
        return managedProcessReaper!.register(record);
      }
      if (method === "managedProcesses.unregister") {
        return managedProcessReaper!.unregister(params);
      }
      if (method === "managedProcesses.confirmLanBind") {
        const body = (params ?? {}) as { ownerSessionId?: unknown; commandHash?: unknown };
        if (
          typeof body.ownerSessionId !== "string" ||
          body.ownerSessionId.length > 128 ||
          typeof body.commandHash !== "string" ||
          !/^[a-f0-9]{16}$/.test(body.commandHash)
        ) {
          throw new Error("Invalid managed process network confirmation request");
        }
        const window = getMainWindow();
        const copy = managedProcessDialogCopy();
        const options = {
          type: "warning" as const,
          title: copy.lanTitle,
          message: copy.lanMessage,
          detail: copy.lanDetail,
          buttons: [copy.allowOnceButton, copy.cancelButton],
          defaultId: 1,
          cancelId: 1,
          noLink: true,
        };
        const result = window ? await dialog.showMessageBox(window, options) : await dialog.showMessageBox(options);
        return { confirmed: result.response === 0 };
      }
      if (method === "managedProcesses.selectExportTarget") {
        const body = (params ?? {}) as { suggestedName?: unknown };
        const suggestedName =
          typeof body.suggestedName === "string" && /^[a-z0-9._-]{1,128}$/i.test(body.suggestedName)
            ? body.suggestedName
            : "managed-process.log";
        const copy = managedProcessDialogCopy();
        const options = {
          title: copy.exportTitle,
          defaultPath: suggestedName,
          filters: [{ name: copy.exportFilter, extensions: ["log", "txt"] }],
          properties: ["showOverwriteConfirmation" as const, "createDirectory" as const],
        };
        const window = getMainWindow();
        const result = window ? await dialog.showSaveDialog(window, options) : await dialog.showSaveDialog(options);
        return result.canceled || !result.filePath
          ? {}
          : { path: result.filePath, fileName: path.basename(result.filePath) };
      }
      if (method.startsWith("browser.")) {
        return browserService!.handleHostRequest(method, params);
      }
      throw new Error(`Unsupported Host request: ${method}`);
    });
    hostManager.setStatusListener((status, detail) => {
      appendMainLog(`host status=${status} ${detail ?? ""}`);
      if (packagedStartupValidation) {
        startupHostReady = status === "ready";
        if (status === "crashed") finishPackagedStartupValidation(detail ?? "Agent Host crashed");
        else finishPackagedStartupValidation();
      }
      if (status !== "ready") {
        runningAgentSessionCount = 0;
        runningManagedProcessCount = 0;
        setTrayRunningCount(0, getMainWindow);
        setTrayManagedProcessCount(0, getMainWindow);
        updateManager?.setRunningSessionCount(0);
        browserService?.onHostStopped();
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
      if (packagedStartupValidation && msg.type === "toolchain:ack") finishPackagedStartupValidation();
      if (msg.type === "running-sessions") {
        const ids = (msg.sessionIds as string[]) ?? [];
        runningAgentSessionCount = ids.length;
        setTrayRunningCount(ids.length, getMainWindow);
        updateManager?.setRunningSessionCount(ids.length);
      } else if (msg.type === "managed-process-count") {
        const count = Number(msg.count);
        runningManagedProcessCount = Number.isSafeInteger(count) && count >= 0 ? count : 0;
        setTrayManagedProcessCount(runningManagedProcessCount, getMainWindow);
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
    void toolchainManager.initialize();
    updateManager.startAutomaticChecks();

    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        createWindow();
      } else {
        getMainWindow()?.show();
      }
    });
  });

  app.on("before-quit", (event) => {
    if (quitCleanupComplete) return;
    event.preventDefault();
    if (quitCleanupStarted) return;
    quitCleanupStarted = true;
    void (async () => {
      if (runningManagedProcessCount > 0 && !packagedStartupValidation) {
        const window = getMainWindow();
        const copy = managedProcessDialogCopy();
        const options = {
          type: "warning" as const,
          title: copy.quitTitle,
          message: copy.quitMessage(runningManagedProcessCount),
          detail: copy.quitDetail,
          buttons: [copy.stopAndQuitButton, copy.cancelButton],
          defaultId: 0,
          cancelId: 1,
          noLink: true,
        };
        const result = window ? await dialog.showMessageBox(window, options) : await dialog.showMessageBox(options);
        if (result.response !== 0) {
          quitCleanupStarted = false;
          isQuitting = false;
          return;
        }
      }
      isQuitting = true;
      updateManager?.stopAutomaticChecks();
      destroyTray();
      const deadline = Date.now() + MANAGED_PROCESS_SHUTDOWN_DEADLINE_MS;
      try {
        const herdrCleanupPromise = beforeDeadline(
          herdrRuntimeManager?.stopManagedServer() ?? Promise.resolve(),
          deadline,
        );
        await cleanupManagedProcesses(deadline, false);
        const herdrCleanup = await herdrCleanupPromise;
        if (!herdrCleanup.completed) appendMainLog("managed Herdr server cleanup reached the shutdown deadline");
        const browserCleanup = await beforeDeadline(browserService?.dispose() ?? Promise.resolve(), deadline);
        if (!browserCleanup.completed) appendMainLog("browser cleanup reached the shutdown deadline");
      } catch (error) {
        appendMainLog(`quit cleanup failed: ${error instanceof Error ? error.message : String(error)}`);
      } finally {
        quitCleanupComplete = true;
        app.quit();
      }
    })();
  });

  app.on("certificate-error", (event, webContents, url, _error, _certificate, callback) => {
    try {
      const hostname = new URL(url).hostname;
      if (browserService?.handleCertificateError(webContents.id, hostname)) {
        event.preventDefault();
        callback(true);
      }
    } catch {
      // Chromium's default certificate policy remains in force.
    }
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
}

startMainProcess();
