import { app, BrowserWindow, crashReporter } from "electron";
import path from "path";
import { HostManager, resolveHostEntry } from "../main/host-manager";
import { installDesktopIpc } from "../main/ipc";
import { appendMainLog } from "../main/logger";
import { handleAppProtocol, registerAppProtocol, rendererRootPath } from "../main/protocol";
import { createMainWindow } from "../main/window";
import { runSmokeHostChecks } from "./host-checks";

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
