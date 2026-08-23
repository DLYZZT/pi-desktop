export interface ManagedProcessCleanupStatus {
  ready: boolean;
  records: number;
  errorCode?: string;
}

export interface ManagedProcessCleanupOptions {
  deadline: number;
  requireConfirmedEmpty: boolean;
  stopHost: () => Promise<unknown>;
  reapAll?: () => Promise<unknown>;
  getStatus?: () => ManagedProcessCleanupStatus;
  log?: (message: string) => void;
}

export async function beforeDeadline<T>(
  work: Promise<T>,
  deadline: number,
): Promise<{ completed: boolean; value?: T }> {
  const remaining = deadline - Date.now();
  if (remaining <= 0) return { completed: false };
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work.then((value) => ({ completed: true as const, value })),
      new Promise<{ completed: false }>((resolve) => {
        timer = setTimeout(() => resolve({ completed: false }), remaining);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function cleanupManagedProcessContainment(options: ManagedProcessCleanupOptions): Promise<void> {
  const log = options.log ?? (() => undefined);
  let hostCompleted = false;
  try {
    hostCompleted = (await beforeDeadline(options.stopHost(), options.deadline)).completed;
  } catch (error) {
    log(`managed process host cleanup failed: ${error instanceof Error ? error.name : "unknown"}`);
  }

  let reaperCompleted = options.reapAll === undefined;
  let reaperFailed = false;
  if (options.reapAll) {
    try {
      reaperCompleted = (await beforeDeadline(options.reapAll(), options.deadline)).completed;
    } catch (error) {
      reaperFailed = true;
      log(`managed process reaper cleanup failed: ${error instanceof Error ? error.name : "unknown"}`);
    }
  }
  const status = options.getStatus?.();
  log(
    `managed process shutdown host=${hostCompleted ? "stopped" : "deadline"} reaper=${reaperCompleted ? "complete" : "deadline"} records=${status?.records ?? 0}${status?.errorCode ? ` error=${status.errorCode}` : ""}`,
  );
  if (
    options.requireConfirmedEmpty &&
    (!hostCompleted || !reaperCompleted || reaperFailed || status?.ready !== true || status.records !== 0)
  ) {
    throw new Error("Managed process cleanup could not be safely confirmed");
  }
}
