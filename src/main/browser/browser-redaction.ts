const SENSITIVE_QUERY_KEY =
  /(?:^|[-_.])(?:access|api|auth|authorization|code|credential|key|nonce|otp|pass|password|secret|session|signature|sig|state|token)(?:$|[-_.])/i;
const SECRET_TEXT =
  /\b(?:bearer\s+[a-z0-9._~+/=-]+|(?:api[-_ ]?key|authorization|cookie|password|passwd|secret|session|token)\s*[:=]\s*[^\s,;]{4,})/gi;
const URL_IN_TEXT = /\bhttps?:\/\/[^\s<>"'`]+/gi;

export function redactBrowserUrl(value: string, maxLength = 8_192): string {
  try {
    const url = new URL(value);
    url.username = "";
    url.password = "";
    for (const key of [...url.searchParams.keys()]) {
      if (SENSITIVE_QUERY_KEY.test(key)) url.searchParams.set(key, "<redacted>");
    }
    url.hash = "";
    return url.toString().slice(0, maxLength);
  } catch {
    return value === "about:blank" ? value : "about:blank";
  }
}

export function redactBrowserText(value: string, maxLength: number): string {
  return value
    .replace(URL_IN_TEXT, (url) => redactBrowserUrl(url, Math.min(8_192, maxLength)))
    .replace(SECRET_TEXT, (match) => `${match.split(/[:=\s]/, 1)[0]}=<redacted>`)
    .slice(0, maxLength);
}
