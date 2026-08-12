export interface RestartableHost {
  stop(): Promise<void>;
  start(): void;
}

export async function restartHostAfterExit(host: RestartableHost, shouldRestart: () => boolean): Promise<boolean> {
  await host.stop();
  if (!shouldRestart()) return false;
  host.start();
  return true;
}
