export function isTrustedPreloadLocation(rawUrl: string): boolean {
  try {
    const url = new URL(rawUrl);
    if (url.protocol === "app:") return url.hostname === "bundle";
    return (
      url.protocol === "http:" && url.port === "5173" && (url.hostname === "localhost" || url.hostname === "127.0.0.1")
    );
  } catch {
    return false;
  }
}
