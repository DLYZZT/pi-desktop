export function isApiShimRequest(input: string | URL | Request, baseHref: string): boolean {
  const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  if (raw.startsWith("/api/")) return true;
  try {
    const base = new URL(baseHref);
    const candidate = new URL(raw, base);
    return (
      candidate.protocol === base.protocol &&
      candidate.hostname === base.hostname &&
      candidate.port === base.port &&
      candidate.pathname.startsWith("/api/")
    );
  } catch {
    return false;
  }
}
