/**
 * System tray — shows running session count; click focuses main window.
 */
import { app, BrowserWindow, Menu, Tray, nativeImage, shell } from "electron";
import path from "path";
import { APP_DOCS_URL } from "../shared/app-links";
import { appendMainLog } from "./logger";

let tray: Tray | null = null;
let runningCount = 0;
let managedProcessCount = 0;
let stopAllManagedProcesses: (() => void) | null = null;

function iconPath(): string {
  // Prefer build/icon.png; fall back to empty template
  return path.join(app.getAppPath(), "build", "icon.png");
}

export function createTray(
  getMainWindow: () => BrowserWindow | null,
  onStopAllManagedProcesses?: () => void,
): Tray | null {
  if (onStopAllManagedProcesses) stopAllManagedProcesses = onStopAllManagedProcesses;
  if (tray) return tray;
  try {
    let image = nativeImage.createFromPath(iconPath());
    if (image.isEmpty()) {
      // 16x16 orange-ish template so tray still appears
      image = nativeImage.createEmpty();
    }
    if (process.platform === "darwin") {
      image = image.resize({ width: 18, height: 18 });
      image.setTemplateImage(true);
    } else {
      image = image.resize({ width: 16, height: 16 });
    }

    tray = new Tray(image);
    tray.setToolTip("Pi Agent Desktop");
    updateTrayMenu(getMainWindow);

    tray.on("click", () => {
      const win = getMainWindow();
      if (!win) return;
      if (win.isMinimized()) win.restore();
      win.show();
      win.focus();
    });

    appendMainLog("tray created");
    return tray;
  } catch (err) {
    appendMainLog(`tray create failed: ${err}`);
    return null;
  }
}

export function setTrayRunningCount(count: number, getMainWindow: () => BrowserWindow | null): void {
  runningCount = Math.max(0, count);
  if (!tray) return;
  tray.setToolTip(runningCount > 0 ? `Pi Agent Desktop — ${runningCount} running` : "Pi Agent Desktop");
  updateTrayMenu(getMainWindow);
}

export function setTrayManagedProcessCount(count: number, getMainWindow: () => BrowserWindow | null): void {
  managedProcessCount = Math.max(0, count);
  if (!tray) return;
  const total = runningCount + managedProcessCount;
  tray.setToolTip(total > 0 ? `Pi Agent Desktop — ${total} running` : "Pi Agent Desktop");
  updateTrayMenu(getMainWindow);
}

function updateTrayMenu(getMainWindow: () => BrowserWindow | null): void {
  if (!tray) return;
  const chinese = app.getLocale().toLowerCase().startsWith("zh");
  const menu = Menu.buildFromTemplate([
    {
      label:
        runningCount > 0
          ? chinese
            ? `运行中的任务：${runningCount}`
            : `Running sessions: ${runningCount}`
          : chinese
            ? "没有运行中的任务"
            : "No running sessions",
      enabled: false,
    },
    {
      label:
        managedProcessCount > 0
          ? chinese
            ? `后台进程：${managedProcessCount}`
            : `Background processes: ${managedProcessCount}`
          : chinese
            ? "没有后台进程"
            : "No background processes",
      enabled: false,
    },
    ...(managedProcessCount > 0
      ? [
          {
            label: chinese ? "停止所有后台进程" : "Stop All Background Processes",
            click: () => stopAllManagedProcesses?.(),
          } as const,
        ]
      : []),
    { type: "separator" },
    {
      label: "Show Window",
      click: () => {
        const win = getMainWindow();
        if (win) {
          win.show();
          win.focus();
        }
      },
    },
    {
      label: "New Session",
      click: () => {
        const win = getMainWindow();
        if (win) {
          win.show();
          win.focus();
          win.webContents.send("menu:new-session");
        }
      },
    },
    { type: "separator" },
    {
      label: "Help",
      click: () => {
        void shell.openExternal(APP_DOCS_URL);
      },
    },
    { type: "separator" },
    {
      label: "Quit",
      click: () => {
        app.quit();
      },
    },
  ]);
  tray.setContextMenu(menu);
}

export function destroyTray(): void {
  tray?.destroy();
  tray = null;
}
