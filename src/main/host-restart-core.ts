export type HostSpawnResult<T> = { ok: true; child: T } | { ok: false; error: string };

export interface HostExitSignal {
  promise: Promise<void>;
  resolve: () => void;
}

export function createHostExitSignal(): HostExitSignal {
  let settled = false;
  let resolvePromise: () => void = () => undefined;
  const promise = new Promise<void>((resolve) => {
    resolvePromise = resolve;
  });
  return {
    promise,
    resolve: () => {
      if (settled) return;
      settled = true;
      resolvePromise();
    },
  };
}

export function trySpawnHost<T>(spawn: () => T): HostSpawnResult<T> {
  try {
    return { ok: true, child: spawn() };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

export interface HostRestartReservation {
  restartTimes: number[];
  attempt: number | null;
}

export function reserveHostRestart(
  restartTimes: readonly number[],
  now: number,
  crashWindowMs: number,
  maxRestarts: number,
): HostRestartReservation {
  const recentRestartTimes = restartTimes.filter((time) => now - time < crashWindowMs);
  if (recentRestartTimes.length >= maxRestarts) {
    return { restartTimes: recentRestartTimes, attempt: null };
  }
  recentRestartTimes.push(now);
  return { restartTimes: recentRestartTimes, attempt: recentRestartTimes.length };
}
