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

export function redactChannelText(raw: unknown): string {
  let text = "";
  if (typeof raw === "string") text = raw;
  else if (raw !== null && raw !== undefined) {
    try {
      text = String(raw);
    } catch {
      text = "[无法显示的渠道内容]";
    }
  }
  return text
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [REDACTED]")
    .replace(/([?&](?:token|qrcode|context_token)=)[^&\s]+/gi, "$1[REDACTED]")
    .replace(/(api\.telegram\.org\/bot)[^/\s]+/gi, "$1[REDACTED]")
    .replace(/("(?:bot_token|token|context_token|qrcode)"\s*:\s*")[^"]+/gi, "$1[REDACTED]");
}

export function safeChannelError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return redactChannelText(raw).slice(0, 500);
}
