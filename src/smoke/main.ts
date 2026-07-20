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
import { isExecutionIntent } from "../shared/toolchains/types";

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

function finish(exitCode: number, error?: unknown): void {
  if (error) {
    appendMainLog(`smoke: checks failed — ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
  }
  hostManager?.stop();
  hostManager = null;
  updateManager?.dispose();
  updateManager = null;
  if (smokeWindow && !smokeWindow.isDestroyed()) smokeWindow.destroy();
  smokeWindow = null;
  app.exit(exitCode);
}

void app.whenReady().then(async () => {
  handleAppProtocol(rendererRootPath(runtimeMainDirectory));
  const updateAdapter = await createProductionUpdateAdapter();
  updateManager = createUpdateManager({
    adapter: updateAdapter,
    currentVersion: app.getVersion(),
    isPackaged: false,
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
  });
  await toolchainManager.initialize();

  hostManager = new HostManager(resolveHostEntry(runtimeMainDirectory));
  const smokeVaultPath = path.join(app.getPath("userData"), "smoke-channel-secrets.json");
  const credentialVault = new CredentialVault(smokeVaultPath);
  hostManager.setToolchainSnapshot(toolchainManager.getSnapshot());
  const credentialRequestHandler = createCredentialRequestHandler(credentialVault);
  hostManager.setRequestHandler(async (method, params) => {
    if (method.startsWith("channelSecrets.")) return credentialRequestHandler(method, params);
    if (method === "toolchain.getSnapshot") return toolchainManager.getSnapshot();
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
    const key = "channel:telegram:smoke-test";
    credentialVault.set(key, {
      token: "smoke-secret",
      providerAccountId: "42",
      providerUsername: "@smoke_bot",
      baseUrl: "https://api.telegram.org",
    });
    const savedCredential = credentialVault.get(key);
    if (savedCredential?.token !== "smoke-secret" || savedCredential.providerAccountId !== "42") {
      finish(1, new Error("Credential vault round-trip failed"));
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
      finish(1, new Error(`Agent Host crashed: ${detail ?? "unknown error"}`));
    }
  });
  hostManager.start();
});

app.on("before-quit", () => hostManager?.stop());
