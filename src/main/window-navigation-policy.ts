export function isAllowedMainNavigation(rawUrl: string, isDev: boolean): boolean {
  try {
    const url = new URL(rawUrl);
    if (url.protocol === "app:") return true;
    if (!isDev || url.protocol !== "http:" || url.port !== "5173") return false;
    return url.hostname === "localhost" || url.hostname === "127.0.0.1";
  } catch {
    return false;
  }
}
