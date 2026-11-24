const ALLOWED_EXTERNAL_PROTOCOLS = new Set([
  "mailto:",
  "tel:",
  "weixin:",
  "dingtalk:",
  "msteams:",
  "slack:",
  "zoommtg:",
]);

/**
 * Only these schemes may leave the managed Browser, and every launch still
 * goes through a local confirmation. `file:`, `javascript:`, `data:` and
 * arbitrary custom schemes stay blocked.
 */
export function isAllowedExternalProtocolUrl(value: string): boolean {
  if (typeof value !== "string" || value.length === 0 || value.length > 8_192 || /[\0\r\n]/.test(value)) {
    return false;
  }
  try {
    return ALLOWED_EXTERNAL_PROTOCOLS.has(new URL(value).protocol.toLowerCase());
  } catch {
    return false;
  }
}

export const BROWSER_EXTERNAL_PROTOCOLS = [...ALLOWED_EXTERNAL_PROTOCOLS];
