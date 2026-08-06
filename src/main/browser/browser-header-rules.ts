import { randomUUID } from "node:crypto";
import type { BrowserHeaderRule } from "../../contract/browser.ts";
import { BrowserError } from "./browser-error.ts";

const FORBIDDEN_REQUEST_HEADERS = new Set([
  "connection",
  "content-length",
  "cookie",
  "host",
  "origin",
  "proxy-authorization",
  "proxy-connection",
  "sec-fetch-dest",
  "sec-fetch-mode",
  "sec-fetch-site",
  "transfer-encoding",
]);
const SITE_SECURITY_RESPONSE_HEADERS = new Set([
  "access-control-allow-credentials",
  "access-control-allow-headers",
  "access-control-allow-methods",
  "access-control-allow-origin",
  "content-security-policy",
  "content-security-policy-report-only",
  "cross-origin-embedder-policy",
  "cross-origin-opener-policy",
  "cross-origin-resource-policy",
  "permissions-policy",
  "x-frame-options",
]);

export function validateHeaderRules(
  profileId: string,
  value: unknown,
  direction: "request" | "response",
  allowSiteSecurityHeaders = false,
): BrowserHeaderRule[] {
  if (!Array.isArray(value) || value.length > 100) {
    throw new BrowserError("INVALID_BROWSER_REQUEST", "Browser header rules must be an array of at most 100 rules");
  }
  return value.map((candidate) => {
    if (!candidate || typeof candidate !== "object") {
      throw new BrowserError("INVALID_BROWSER_REQUEST", "Browser header rule is invalid");
    }
    const rule = candidate as Partial<BrowserHeaderRule>;
    const header = normalizeHeaderName(rule.header);
    if (rule.profileId !== profileId) {
      throw new BrowserError("INVALID_BROWSER_REQUEST", "Browser header rule profile does not match");
    }
    if (direction === "request" && (FORBIDDEN_REQUEST_HEADERS.has(header) || header.startsWith("sec-ch-"))) {
      throw new BrowserError("HEADER_NOT_OVERRIDABLE", `Request header cannot be overridden: ${header}`);
    }
    if (direction === "response" && SITE_SECURITY_RESPONSE_HEADERS.has(header) && !allowSiteSecurityHeaders) {
      throw new BrowserError(
        "HEADER_NOT_OVERRIDABLE",
        `Site security header requires an Advanced Browser Mode Profile: ${header}`,
      );
    }
    if (!rule.urlPattern || typeof rule.urlPattern !== "string" || rule.urlPattern.length > 1_024) {
      throw new BrowserError("INVALID_BROWSER_REQUEST", "Browser header rule URL pattern is invalid");
    }
    compileUrlPattern(rule.urlPattern);
    if (rule.operation !== "set" && rule.operation !== "remove" && rule.operation !== "append") {
      throw new BrowserError("INVALID_BROWSER_REQUEST", "Browser header rule operation is invalid");
    }
    if (rule.operation !== "remove" && !rule.value && !rule.secretRef) {
      throw new BrowserError("INVALID_BROWSER_REQUEST", "Browser header rule value is missing");
    }
    if (
      rule.value &&
      (typeof rule.value !== "string" || rule.value.length > 16 * 1024 || /[\0\r\n]/.test(rule.value))
    ) {
      throw new BrowserError("INVALID_BROWSER_REQUEST", "Browser header value is invalid");
    }
    if (rule.secretRef && (typeof rule.secretRef !== "string" || !rule.secretRef.startsWith("browser-secret-"))) {
      throw new BrowserError("INVALID_BROWSER_REQUEST", "Browser header secret reference is invalid");
    }
    if (header === "authorization" && rule.operation !== "remove" && !rule.secretRef) {
      throw new BrowserError("HEADER_NOT_OVERRIDABLE", "Authorization values must use secure secret storage");
    }
    const resourceTypes = Array.isArray(rule.resourceTypes)
      ? rule.resourceTypes.map((type) => {
          if (typeof type !== "string" || !/^[a-z][a-zA-Z]{1,32}$/.test(type)) {
            throw new BrowserError("INVALID_BROWSER_REQUEST", "Browser header resource type is invalid");
          }
          return type;
        })
      : undefined;
    return {
      id: typeof rule.id === "string" && /^[a-z0-9_-]{1,128}$/i.test(rule.id) ? rule.id : randomUUID(),
      enabled: rule.enabled !== false,
      profileId,
      urlPattern: rule.urlPattern,
      ...(resourceTypes ? { resourceTypes } : {}),
      header,
      operation: rule.operation,
      ...(rule.value ? { value: rule.value } : {}),
      ...(rule.secretRef ? { secretRef: rule.secretRef } : {}),
    };
  });
}

export function applyHeaderRules(
  original: Record<string, string | string[]>,
  rules: readonly BrowserHeaderRule[],
  url: string,
  resourceType: string,
  resolveSecret: (ref: string) => string | undefined,
): Record<string, string | string[]> {
  const headers = { ...original };
  for (const rule of rules) {
    if (!rule.enabled || !matchesHeaderRule(rule, url, resourceType)) continue;
    const key = Object.keys(headers).find((entry) => entry.toLowerCase() === rule.header.toLowerCase()) ?? rule.header;
    if (rule.operation === "remove") {
      delete headers[key];
      continue;
    }
    const value = rule.secretRef ? resolveSecret(rule.secretRef) : rule.value;
    if (value === undefined) continue;
    if (rule.operation === "set") headers[key] = value;
    else {
      const current = headers[key];
      headers[key] = Array.isArray(current) ? [...current, value] : current ? [current, value] : value;
    }
  }
  return headers;
}

export function matchesHeaderRule(rule: BrowserHeaderRule, url: string, resourceType: string): boolean {
  return (
    (!rule.resourceTypes || rule.resourceTypes.includes(resourceType)) && compileUrlPattern(rule.urlPattern).test(url)
  );
}

export function isSiteSecurityResponseHeader(header: string): boolean {
  return SITE_SECURITY_RESPONSE_HEADERS.has(header.toLowerCase());
}

function normalizeHeaderName(value: unknown): string {
  if (typeof value !== "string" || !/^[!#$%&'*+.^_`|~0-9a-z-]{1,128}$/i.test(value)) {
    throw new BrowserError("INVALID_BROWSER_REQUEST", "Browser header name is invalid");
  }
  return value.toLowerCase();
}

function compileUrlPattern(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replaceAll("*", ".*");
  try {
    return new RegExp(`^${escaped}$`, "i");
  } catch {
    throw new BrowserError("INVALID_BROWSER_REQUEST", "Browser header URL pattern is invalid");
  }
}
