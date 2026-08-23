import type { UpdateAdapter, UpdateAdapterEventMap } from "./update-adapter.ts";
import { createUpdateManager } from "./update-manager.ts";
import { cleanupManagedProcessContainment } from "./managed-process/shutdown-cleanup.ts";

export interface PackagedCleanupFaultValidationReport {
  ok: boolean;
  productionDeadlineMs: number;
  ordinaryQuitCompleted: boolean;
  ordinaryQuitDurationMs: number;
  journalRetained: boolean;
  installRejected: boolean;
  installRejectedCode?: string;
  installerLaunches: number;
  recoveries: number;
  updatePhase: string;
  canRetry: boolean;
}

class ValidationUpdateAdapter implements UpdateAdapter {
  private readonly listeners = new Map<keyof UpdateAdapterEventMap, Set<(...args: never[]) => void>>();
  installerLaunches = 0;

  on<Event extends keyof UpdateAdapterEventMap>(event: Event, listener: UpdateAdapterEventMap[Event]): () => void {
    const listeners = this.listeners.get(event) ?? new Set<(...args: never[]) => void>();
    listeners.add(listener as (...args: never[]) => void);
    this.listeners.set(event, listeners);
    return () => listeners.delete(listener as (...args: never[]) => void);
  }

  async checkForUpdates(): Promise<void> {
    this.emit("update-available", updateInfo());
  }

  async downloadUpdate(): Promise<void> {
    this.emit("update-downloaded", { ...updateInfo(), downloadedFile: "packaged-validation.exe" });
  }

  quitAndInstall(): void {
    this.installerLaunches += 1;
  }

  private emit<Event extends keyof UpdateAdapterEventMap>(
    event: Event,
    ...args: Parameters<UpdateAdapterEventMap[Event]>
  ): void {
    for (const listener of this.listeners.get(event) ?? []) {
      (listener as (...values: Parameters<UpdateAdapterEventMap[Event]>) => void)(...args);
    }
  }
}

function updateInfo(): Parameters<UpdateAdapterEventMap["update-available"]>[0] {
  return {
    version: "999.0.0-validation",
    files: [],
    path: "packaged-validation.exe",
    sha512: "validation-only",
    releaseDate: "2026-01-01T00:00:00.000Z",
  };
}

export async function runPackagedCleanupFaultValidation(options: {
  productionDeadlineMs: number;
  faultDeadlineMs?: number;
}): Promise<PackagedCleanupFaultValidationReport> {
  const faultDeadlineMs = options.faultDeadlineMs ?? 200;
  const uncertain = { ready: false, records: 1, errorCode: "IDENTITY_UNCERTAIN" };
  const ordinaryStartedAt = Date.now();
  await cleanupManagedProcessContainment({
    deadline: ordinaryStartedAt + faultDeadlineMs,
    requireConfirmedEmpty: false,
    stopHost: () => new Promise(() => undefined),
    reapAll: async () => undefined,
    getStatus: () => uncertain,
  });
  const ordinaryQuitDurationMs = Date.now() - ordinaryStartedAt;

  const adapter = new ValidationUpdateAdapter();
  let recoveries = 0;
  const manager = createUpdateManager({
    adapter,
    currentVersion: "0.0.0-validation",
    isPackaged: true,
    platform: "win32",
    automaticChecksEnabled: false,
    prepareToInstall: () =>
      cleanupManagedProcessContainment({
        deadline: Date.now() + faultDeadlineMs,
        requireConfirmedEmpty: true,
        stopHost: async () => undefined,
        reapAll: async () => undefined,
        getStatus: () => uncertain,
      }),
    recoverFromInstallFailure: () => {
      recoveries += 1;
    },
  });

  let installRejected = false;
  let installRejectedCode: string | undefined;
  try {
    await manager.checkForUpdates();
    await manager.downloadUpdate();
    await manager.installUpdate();
  } catch (error) {
    installRejected = true;
    installRejectedCode =
      error && typeof error === "object" && "code" in error && typeof error.code === "string" ? error.code : undefined;
  }
  const state = manager.getState();
  manager.dispose();

  const report: PackagedCleanupFaultValidationReport = {
    ok: false,
    productionDeadlineMs: options.productionDeadlineMs,
    ordinaryQuitCompleted: ordinaryQuitDurationMs <= Math.max(2_000, faultDeadlineMs * 5),
    ordinaryQuitDurationMs,
    journalRetained: uncertain.records === 1 && uncertain.errorCode === "IDENTITY_UNCERTAIN",
    installRejected,
    ...(installRejectedCode ? { installRejectedCode } : {}),
    installerLaunches: adapter.installerLaunches,
    recoveries,
    updatePhase: state.phase,
    canRetry: state.canRetry,
  };
  report.ok =
    report.productionDeadlineMs === 15_000 &&
    report.ordinaryQuitCompleted &&
    report.journalRetained &&
    report.installRejected &&
    report.installerLaunches === 0 &&
    report.recoveries === 1 &&
    report.updatePhase === "error" &&
    report.canRetry;
  return report;
}
