import type { AppUpdater, ProgressInfo, UpdateDownloadedEvent, UpdateInfo } from "electron-updater";

export type UpdateAdapterEventMap = {
  error: (error: Error, message?: string) => void;
  "checking-for-update": () => void;
  "update-not-available": (info: UpdateInfo) => void;
  "update-available": (info: UpdateInfo) => void;
  "update-downloaded": (info: UpdateDownloadedEvent) => void;
  "download-progress": (info: ProgressInfo) => void;
};

/**
 * Small, injectable surface around electron-updater. Tests can implement this
 * interface without loading Electron or contacting an update server.
 */
export interface UpdateAdapter {
  on<Event extends keyof UpdateAdapterEventMap>(event: Event, listener: UpdateAdapterEventMap[Event]): () => void;
  checkForUpdates(): Promise<unknown>;
  downloadUpdate(): Promise<unknown>;
  quitAndInstall(isSilent?: boolean, isForceRunAfter?: boolean): void;
}

type ElectronUpdaterModule = typeof import("electron-updater") & {
  default?: { autoUpdater?: AppUpdater };
};

export interface ProductionUpdateAdapterOptions {
  useDevelopmentConfig?: boolean;
}

// Windows updates stay fail-closed until the release workflow signs both the
// installed application and every NSIS update with the configured publisher.
export const WINDOWS_UPDATES_RELEASE_READY = false;

export function isProductionUpdatePlatformEnabled(platform: NodeJS.Platform): boolean {
  return platform === "darwin" || (platform === "win32" && WINDOWS_UPDATES_RELEASE_READY);
}

class ProductionUpdateAdapter implements UpdateAdapter {
  private readonly updater: AppUpdater;

  constructor(updater: AppUpdater) {
    this.updater = updater;
  }

  on<Event extends keyof UpdateAdapterEventMap>(event: Event, listener: UpdateAdapterEventMap[Event]): () => void {
    // AppUpdater has strongly typed overloads, while this adapter exposes the
    // same callbacks through a generic event map.
    const updater = this.updater as unknown as {
      on(name: string, callback: (...args: never[]) => void): void;
      off(name: string, callback: (...args: never[]) => void): void;
    };
    const callback = listener as (...args: never[]) => void;
    updater.on(event, callback);
    return () => updater.off(event, callback);
  }

  checkForUpdates(): Promise<unknown> {
    return this.updater.checkForUpdates();
  }

  downloadUpdate(): Promise<unknown> {
    return this.updater.downloadUpdate();
  }

  quitAndInstall(isSilent = false, isForceRunAfter = true): void {
    this.updater.quitAndInstall(isSilent, isForceRunAfter);
  }
}

/** @internal Exported to verify the production policy without loading Electron. */
export function wrapElectronUpdater(updater: AppUpdater, options: ProductionUpdateAdapterOptions = {}): UpdateAdapter {
  updater.autoDownload = false;
  updater.autoInstallOnAppQuit = true;
  updater.allowPrerelease = false;
  updater.allowDowngrade = false;
  updater.forceDevUpdateConfig = options.useDevelopmentConfig === true;

  // Avoid leaking request headers, URLs, or cache paths through the library's
  // default console logger. UpdateManager emits its own redacted messages.
  updater.logger = null;

  return new ProductionUpdateAdapter(updater);
}

/**
 * Loads electron-updater only when the packaged main process asks for it.
 * This keeps ordinary Node tests from initializing Electron's AppUpdater.
 */
export async function createProductionUpdateAdapter(
  options: ProductionUpdateAdapterOptions = {},
): Promise<UpdateAdapter> {
  const imported = (await import("electron-updater")) as ElectronUpdaterModule;
  const updater = imported.autoUpdater ?? imported.default?.autoUpdater;
  if (!updater) {
    throw new Error("electron-updater did not expose autoUpdater");
  }
  return wrapElectronUpdater(updater, options);
}
