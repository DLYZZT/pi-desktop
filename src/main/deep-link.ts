export type DesktopDeepLink = { sessionId: string };

export function parseDesktopDeepLink(value: string): DesktopDeepLink | null {
  try {
    const url = new URL(value);
    if (url.protocol !== "pi-agent-desktop:") return null;
    if (url.hostname.toLowerCase() === "session") {
      const sessionId = url.pathname.replace(/^\//, "");
      return sessionId ? { sessionId } : null;
    }
    if (url.pathname.startsWith("/session/")) {
      const sessionId = url.pathname.slice("/session/".length);
      return sessionId ? { sessionId } : null;
    }
  } catch {
    /* invalid argv entry */
  }
  return null;
}

export function findDesktopDeepLink(argv: readonly string[]): string | undefined {
  return argv.find((value) => parseDesktopDeepLink(value) !== null);
}
