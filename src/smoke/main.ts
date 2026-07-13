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

registerAppProtocol();
crashReporter.start({
  productName: "Pi Agent Desktop Smoke",
  uploadToServer: false,
  compress: false,
});

const runtimeMainDirectory = path.join(process.cwd(), "out", "main");
let hostManager: HostManager | null = null;
let smokeWindow: BrowserWindow | null = null;
let checksStarted = false;

function finish(exitCode: number, error?: unknown): void {
  if (error) {
    appendMainLog(`smoke: checks failed — ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
  }
  hostManager?.stop();
  hostManager = null;
  if (smokeWindow && !smokeWindow.isDestroyed()) smokeWindow.destroy();
  smokeWindow = null;
  app.exit(exitCode);
}

void app.whenReady().then(() => {
  handleAppProtocol(rendererRootPath(runtimeMainDirectory));

  hostManager = new HostManager(resolveHostEntry(runtimeMainDirectory));
  const smokeVaultPath = path.join(app.getPath("userData"), "smoke-channel-secrets.json");
  const credentialVault = new CredentialVault(smokeVaultPath);
  hostManager.setRequestHandler(createCredentialRequestHandler(credentialVault));
  if (safeStorage.isEncryptionAvailable()) {
    const key = "channel:weixin:smoke-test";
    credentialVault.set(key, { token: "smoke-secret" });
    if (credentialVault.get(key)?.token !== "smoke-secret") {
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
