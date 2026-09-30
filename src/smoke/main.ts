import { app, BrowserWindow, crashReporter, safeStorage } from "electron";
import fs from "node:fs";
import path from "path";
import { HostManager, resolveHostEntry } from "../main/host-manager";
import { installDesktopIpc } from "../main/ipc";
import { appendMainLog } from "../main/logger";
import { handleAppProtocol, registerAppProtocol, rendererRootPath } from "../main/protocol";
import { createMainWindow } from "../main/window";
import { runSmokeHostChecks } from "./host-checks";
import { createCredentialRequestHandler, CredentialVault } from "../main/credential-vault";
import { createProductionUpdateAdapter } from "../main/update-adapter";
import { createUpdateManager, type UpdateManager } from "../main/update-manager";
import { ToolchainManager } from "../main/toolchains/manager";
import { resolveRuntimeCatalogPath } from "../main/toolchains/catalog";
import { resolveBundledCorePaths } from "../main/toolchains/bundled-core";
import { isExecutionIntent } from "../shared/toolchains/types";
import os from "node:os";
import { ManagedProcessReaper, secureWindowsReaperDirectory } from "../main/managed-process/reaper";
import { projectManagedProcessCapability } from "../main/managed-process/capability";
import {
  resolveWindowsManagedProcessHelper,
  type WindowsManagedProcessHelperResolution,
} from "../shared/windows-managed-process-helper";

const smokeUserData = process.env.PI_DESKTOP_SMOKE_USER_DATA;
if (!smokeUserData || !path.isAbsolute(smokeUserData)) {
  throw new Error("PI_DESKTOP_SMOKE_USER_DATA must be an absolute temporary directory");
}
app.setPath("userData", smokeUserData);

registerAppProtocol();
crashReporter.start({
  productName: "Pi Agent Desktop Smoke",
  uploadToServer: false,
  compress: false,
});

const runtimeMainDirectory = path.join(process.cwd(), "out", "main");
let hostManager: HostManager | null = null;
let smokeWindow: BrowserWindow | null = null;
let updateManager: UpdateManager | null = null;
let checksStarted = false;
let reaper: ManagedProcessReaper | null = null;
let helper: WindowsManagedProcessHelperResolution | null = null;
let finishing = false;

function finish(exitCode: number, error?: unknown): void {
  if (finishing) return;
  finishing = true;
  if (error) {
    appendMainLog(`smoke: checks failed — ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
  }
  void (async () => {
    await hostManager?.stop();
    await reaper?.reapAll();
    hostManager = null;
    updateManager?.dispose();
    updateManager = null;
    if (smokeWindow && !smokeWindow.isDestroyed()) smokeWindow.destroy();
    smokeWindow = null;
    app.exit(exitCode);
  })().catch((failure) => {
    appendMainLog("smoke shutdown failed: " + String(failure));
    app.exit(1);
  });
}

void app.whenReady().then(async () => {
  handleAppProtocol(rendererRootPath(runtimeMainDirectory));
  const updateAdapter = await createProductionUpdateAdapter();
  updateManager = createUpdateManager({
    adapter: updateAdapter,
    currentVersion: app.getVersion(),
    isPackaged: false,
  });
  const bundledCorePaths = resolveBundledCorePaths({
    isPackaged: false,
    resourcesRoot: process.resourcesPath,
  });
  const toolchainManager = new ToolchainManager({
    homeDir: app.getPath("home"),
    tempRoot: app.getPath("temp"),
    userDataRoot: app.getPath("userData"),
    resourcesRoot: process.resourcesPath,
    catalogPath: resolveRuntimeCatalogPath({
      isPackaged: false,
      resourcesRoot: process.resourcesPath,
    }),
    coreCatalogPath: bundledCorePaths.catalogPath,
    bundledCoreRoot: bundledCorePaths.coreRoot,
  });
  await toolchainManager.initialize();

  hostManager = new HostManager(resolveHostEntry(runtimeMainDirectory));
  const reaperDirectory = path.join(smokeUserData, "managed-process-reaper");
  if (process.platform === "win32")
    helper = resolveWindowsManagedProcessHelper({
      isPackaged: false,
      resourcesPath: process.resourcesPath,
      projectRoot: process.cwd(),
    });
  const secured =
    process.platform !== "win32" ||
    Boolean(helper?.ok && (await secureWindowsReaperDirectory(reaperDirectory, helper.descriptor, appendMainLog)));
  reaper = new ManagedProcessReaper(path.join(reaperDirectory, "journal-v2.json"), {
    log: appendMainLog,
    ...(helper?.ok && secured ? { windowsHelper: helper.descriptor } : {}),
  });
  await reaper.initialize();
  hostManager.setBeforeRestartHandler(async () => {
    const status = await reaper!.reapAll();
    if (!status.ready || status.records) throw new Error("Smoke process cleanup blocked Host restart");
  });
  const capability = () =>
    projectManagedProcessCapability({
      platform: process.platform,
      arch: process.arch,
      reaperReady: reaper?.status().ready === true,
      helper,
      ownerReady: hostManager?.getManagedProcessOwnerState().ready === true,
      windowsRelease: os.release(),
      windowsVersion: os.version(),
    });
  const smokeVaultPath = path.join(app.getPath("userData"), "smoke-channel-secrets.json");
  const credentialVault = new CredentialVault(smokeVaultPath);
  hostManager.setToolchainSnapshot(toolchainManager.getSnapshot());
  const credentialRequestHandler = createCredentialRequestHandler(credentialVault);
  hostManager.setRequestHandler(async (method, params) => {
    if (method.startsWith("channelSecrets.")) return credentialRequestHandler(method, params);
    if (method === "toolchain.getSnapshot") return toolchainManager.getSnapshot();
    if (method === "managedProcesses.getSettings")
      return {
        enabled: true,
        reaperReady: reaper!.status().ready,
        capability: capability(),
        ...(helper?.ok ? { windowsHelper: helper.descriptor } : {}),
      };
    if (method === "managedProcesses.register") {
      const record = (params as { record?: { platform?: string; hostInstanceId?: string } }).record;
      const owner = hostManager!.getManagedProcessOwnerState();
      if (record?.platform === "win32" && (!owner.ready || record.hostInstanceId !== owner.hostInstanceId))
        throw new Error("Smoke Windows process owner generation mismatch");
      return reaper!.register(record);
    }
    if (method === "managedProcesses.unregister") return reaper!.unregister(params);
    if (method === "toolchain.resolve") {
      const body = (params ?? {}) as { cwd?: unknown; intent?: unknown; trusted?: unknown };
      if (
        typeof body.cwd !== "string" ||
        !path.isAbsolute(body.cwd) ||
        !isExecutionIntent(body.intent) ||
        typeof body.trusted !== "boolean"
      ) {
        throw new Error("Invalid smoke toolchain request");
      }
      return toolchainManager.resolveForProject(body.cwd, { intent: body.intent, trusted: body.trusted });
    }
    throw new Error(`Unsupported smoke Host request: ${method}`);
  });
  if (safeStorage.isEncryptionAvailable()) {
    const key = "channel:feishu:smoke-test";
    credentialVault.set(key, {
      token: "smoke-app-secret",
      providerAccountId: "ou_smoke_bot",
      baseUrl: "https://open.feishu.cn",
    });
    const rawVault = fs.readFileSync(smokeVaultPath, "utf8");
    const savedCredential = new CredentialVault(smokeVaultPath).get(key);
    if (
      rawVault.includes("smoke-app-secret") ||
      savedCredential?.token !== "smoke-app-secret" ||
      savedCredential.providerAccountId !== "ou_smoke_bot"
    ) {
      finish(1, new Error("Credential vault reload failed"));
      return;
    }
    credentialVault.delete(key);
    try {
      fs.unlinkSync(smokeVaultPath);
    } catch {
      /* ignore cleanup failure */
    }
  }
  installDesktopIpc({
    getHostManager: () => hostManager,
    getMainWindow: () => smokeWindow,
    getUnreadBadge: () => 0,
    applyBadgeCount: () => {},
    getToolchainState: () => toolchainManager.getPublicState(),
    rescanToolchains: async (cwd) => (await toolchainManager.rescan({ cwd })).publicState,
    performToolchainAction: (request) => toolchainManager.performAction(request),
    chooseCustomTool: (capability, executable) => toolchainManager.registerCustomTool(capability, executable),
    setChannelCredential: (payload) =>
      credentialVault.set(`channel:${payload.channel}:${payload.accountId}`, payload.credential),
    getBrowserService: () => null,
    getManagedProcessCapability: capability,
    updateManager,
  });

  hostManager.setStatusListener((status, detail) => {
    appendMainLog(`smoke: host status=${status} ${detail ?? ""}`);
    const manager = hostManager;
    if (status === "ready" && manager && !checksStarted) {
      checksStarted = true;
      void runSmokeHostChecks(manager, (onConsoleError) => {
        smokeWindow = createMainWindow({
          isDev: false,
          show: false,
          runtimeMainDirectory,
          onConsoleError,
          onClosed: () => {
            smokeWindow = null;
          },
        });
        return smokeWindow;
      }).then(
        () => finish(0),
        (error) => finish(1, error),
      );
    } else if (status === "crashed") {
      if (process.env.PI_DESKTOP_EXECUTION_RECOVERY === "1" && detail?.includes("restart budget exhausted")) return;
      finish(1, new Error(`Agent Host crashed: ${detail ?? "unknown error"}`));
    }
  });
  hostManager.start();
});

app.on("before-quit", () => void hostManager?.stop());
