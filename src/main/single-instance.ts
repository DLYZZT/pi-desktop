import { app, type BrowserWindow } from "electron";

/**
 * Enforce a single desktop instance. Returns false if this process should exit.
 */
export function acquireSingleInstanceLock(
  getMainWindow: () => BrowserWindow | null,
  onSecondInstance?: (argv: string[]) => void,
): boolean {
  const got = app.requestSingleInstanceLock();
  if (!got) return false;

  app.on("second-instance", (_event, argv) => {
    const win = getMainWindow();
    if (win) {
      if (win.isMinimized()) win.restore();
      win.show();
      win.focus();
    }
    onSecondInstance?.(argv);
  });

  return true;
}
