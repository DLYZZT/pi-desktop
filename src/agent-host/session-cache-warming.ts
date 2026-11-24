import type { SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { validateExistingDirectory } from "./directory-validation.ts";

const copying = new Map<string, number>();

export function suspendForkCacheWarming(id: string): () => void {
  copying.set(id, (copying.get(id) ?? 0) + 1);
  return () => {
    const remaining = copying.get(id)! - 1;
    if (remaining) copying.set(id, remaining);
    else copying.delete(id);
  };
}

/** Pi consults its session's settings before replaying a request and again before appending usage. */
export function guardSessionCacheWarming(
  settings: Pick<SettingsManager, "getCacheWarmingMode">,
  session: Pick<SessionManager, "getSessionId" | "getCwd">,
): void {
  const configured = settings.getCacheWarmingMode.bind(settings);
  settings.getCacheWarmingMode = () => {
    const mode = configured();
    if (mode === "off" || copying.has(session.getSessionId()) || !validateExistingDirectory(session.getCwd()).ok)
      return "off";
    return mode;
  };
}
