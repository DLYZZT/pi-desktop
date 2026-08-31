const sessionSources = new WeakMap<object, "local" | "channel">();

export function setAgentSessionSource(sessionManager: object, source: "local" | "channel"): void {
  sessionSources.set(sessionManager, source);
}

export function getAgentSessionSource(sessionManager: object): "local" | "channel" | "unknown" {
  return sessionSources.get(sessionManager) ?? "unknown";
}

// Compatibility aliases for the existing Browser call sites.
export const setBrowserSessionSource = setAgentSessionSource;
export const getBrowserSessionSource = getAgentSessionSource;
