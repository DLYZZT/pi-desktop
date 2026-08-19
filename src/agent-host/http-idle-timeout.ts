import { getAgentDir, SettingsManager } from "@earendil-works/pi-coding-agent";

export async function installHttpIdleTimeout(
  loadDispatcher: () => Promise<{ configureHttpDispatcher: (timeoutMs?: number) => void }> = loadPiHttpDispatcher,
): Promise<number> {
  const { configureHttpDispatcher } = await loadDispatcher();
  const timeoutMs = SettingsManager.create(process.cwd(), getAgentDir()).getHttpIdleTimeoutMs();
  configureHttpDispatcher(timeoutMs);
  return timeoutMs;
}

export function loadPiHttpDispatcher(): Promise<{ configureHttpDispatcher: (timeoutMs?: number) => void }> {
  const entry = import.meta.resolve("@earendil-works/pi-coding-agent");
  return import(new URL("./core/http-dispatcher.js", entry).href);
}
