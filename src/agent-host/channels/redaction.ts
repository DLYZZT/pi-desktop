const SENSITIVE_KEYS = /token|secret|authorization|qrcode|context[_-]?token|encrypt[_-]?query/i;

export function fingerprintSecret(secret: string): string | undefined {
  const trimmed = secret.trim();
  if (!trimmed) return undefined;
  return `••••${trimmed.slice(-4)}`;
}

export function redactChannelValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactChannelValue);
  if (!value || typeof value !== "object") return value;
  const result: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    result[key] = SENSITIVE_KEYS.test(key) ? "[REDACTED]" : redactChannelValue(child);
  }
  return result;
}

export function safeChannelError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return raw
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [REDACTED]")
    .replace(/([?&](?:token|qrcode|context_token)=)[^&\s]+/gi, "$1[REDACTED]")
    .replace(/("(?:bot_token|token|context_token|qrcode)"\s*:\s*")[^"]+/gi, "$1[REDACTED]")
    .slice(0, 500);
}
