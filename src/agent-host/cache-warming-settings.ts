import { getAgentDir, SettingsManager } from "@earendil-works/pi-coding-agent";
import { syncCacheWarmingForAllSessions } from "./rpc-manager.ts";

export type CacheWarmingMode = "off" | "streaming" | "idle";
export type CacheWarmingStatus = {
  mode: CacheWarmingMode;
  scope: "global";
  loadFailed: boolean;
  pendingSessionCount: number;
};

export function isCacheWarmingMode(value: unknown): value is CacheWarmingMode {
  return value === "off" || value === "streaming" || value === "idle";
}

export class CacheWarmingSettings {
  private readonly createSettings: () => SettingsManager;
  private readonly syncSessions: (mode: CacheWarmingMode) => Promise<number>;
  private tail: Promise<unknown> = Promise.resolve();

  constructor(
    createSettings: () => SettingsManager = () => SettingsManager.create(getAgentDir(), getAgentDir()),
    syncSessions: (mode: CacheWarmingMode) => Promise<number> = syncCacheWarmingForAllSessions,
  ) {
    this.createSettings = createSettings;
    this.syncSessions = syncSessions;
  }

  async get(): Promise<CacheWarmingStatus> {
    await this.tail;
    const settings = this.createSettings();
    return {
      mode: settings.getCacheWarmingMode(),
      scope: "global",
      loadFailed: settings.drainErrors().some((error) => error.scope === "global"),
      pendingSessionCount: 0,
    };
  }

  set(mode: CacheWarmingMode): Promise<CacheWarmingStatus> {
    if (!isCacheWarmingMode(mode)) return Promise.reject(new TypeError("Invalid cache warming mode"));
    const operation = this.tail.then(async () => {
      const settings = this.createSettings();
      if (settings.drainErrors().some((error) => error.scope === "global")) {
        throw new Error("Global Pi settings could not be loaded");
      }
      settings.setCacheWarmingMode(mode);
      await settings.flush();
      const failedWrite = settings.drainErrors().some((error) => error.scope === "global");
      const saved = this.createSettings();
      const persistedMode = saved.getCacheWarmingMode();
      if (failedWrite || saved.drainErrors().some((error) => error.scope === "global") || persistedMode !== mode) {
        throw new Error("Global Pi settings could not be saved");
      }
      const pendingSessionCount = await this.syncSessions(mode);
      return { mode, scope: "global" as const, loadFailed: false, pendingSessionCount };
    });
    this.tail = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }
}

export const cacheWarmingSettings = new CacheWarmingSettings();
