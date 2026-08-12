import type { BrowserErrorCode, BrowserRecovery, BrowserStructuredError } from "../../contract/browser.ts";

export class BrowserError extends Error {
  readonly code: BrowserErrorCode;
  readonly retryable: boolean;
  readonly recovery: BrowserRecovery;
  readonly details?: Record<string, unknown>;

  constructor(
    code: BrowserErrorCode,
    message: string,
    options: {
      retryable?: boolean;
      recovery?: Partial<BrowserRecovery>;
      details?: Record<string, unknown>;
      cause?: unknown;
    } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "BrowserError";
    this.code = code;
    this.recovery = browserRecoveryForCode(code, options.retryable, options.recovery);
    this.retryable = this.recovery.retryable;
    this.details = options.details;
  }

  toJSON(): BrowserStructuredError {
    return {
      code: this.code,
      message: this.message,
      retryable: this.retryable,
      recovery: structuredClone(this.recovery),
      ...(this.details ? { details: structuredClone(this.details) } : {}),
    };
  }
}

export function asBrowserError(
  error: unknown,
  fallbackCode: BrowserErrorCode = "INVALID_BROWSER_REQUEST",
): BrowserError {
  if (error instanceof BrowserError) return error;
  return new BrowserError(fallbackCode, error instanceof Error ? error.message : String(error), { cause: error });
}

function browserRecoveryForCode(
  code: BrowserErrorCode,
  retryableOverride?: boolean,
  override: Partial<BrowserRecovery> = {},
): BrowserRecovery {
  let recovery: BrowserRecovery;
  switch (code) {
    case "STALE_ELEMENT_REF":
    case "INSPECTION_STALE":
      recovery = { retryable: false, reason: "stale-state", remediation: "refresh-inspection" };
      break;
    case "TAB_NOT_FOUND":
    case "TAB_NOT_OWNED":
    case "TAB_CRASHED":
      recovery = { retryable: false, reason: "target-closed", remediation: "list-owned-tabs" };
      break;
    case "NAVIGATION_FAILED":
    case "ACTION_TIMEOUT":
    case "PROFILE_DELETE_RETRY_REQUIRED":
      recovery = {
        retryable: true,
        reason: "transient-network",
        remediation: "wait-and-retry-once",
        retryAfterMs: 250,
      };
      break;
    case "BROWSER_DISABLED":
    case "CAPABILITY_DISABLED":
    case "ADVANCED_BROWSER_MODE_REQUIRED":
    case "ADVANCED_CONFIRMATION_REQUIRED":
    case "CAPABILITY_LEASE_EXPIRED":
    case "POLICY_REVISION_MISMATCH":
    case "USER_DENIED":
    case "AUTHORIZATION_TIMEOUT":
    case "PERMISSION_DENIED":
      recovery = { retryable: false, reason: "permission-required", remediation: "request-authorization" };
      break;
    case "PRIVATE_NETWORK_BLOCKED":
      recovery = {
        retryable: false,
        reason: "policy-denied",
        remediation: "request-local-network-authorization",
      };
      break;
    case "NAVIGATION_BLOCKED":
    case "NETWORK_ISOLATION_UNAVAILABLE":
    case "UNSUPPORTED_PROTOCOL":
    case "BROWSER_ROUTE_BYPASS_BLOCKED":
      recovery = { retryable: false, reason: "policy-denied", remediation: "ask-user" };
      break;
    case "BROWSER_REPLAN_REQUIRED":
      recovery = { retryable: false, reason: "stale-state", remediation: "ask-user" };
      break;
    case "JAVASCRIPT_EXECUTION_FAILED":
      recovery = { retryable: false, reason: "invalid-input", remediation: "change-input" };
      break;
    default:
      recovery = { retryable: false, reason: "unsupported", remediation: "none" };
      break;
  }
  return {
    ...recovery,
    ...override,
    retryable: retryableOverride ?? override.retryable ?? recovery.retryable,
  };
}
