import { translate } from "../../i18n.ts";

const ERROR_COPY: Array<[string, string, string]> = [
  ["USER_DENIED", "browserErrorUserDenied", "Browser access was denied."],
  ["AUTHORIZATION_TIMEOUT", "browserErrorAuthorizationTimeout", "Browser authorization timed out."],
  ["BROWSER_DISABLED", "browserErrorDisabled", "The built-in Browser is disabled."],
  ["CAPABILITY_DISABLED", "browserErrorCapabilityDisabled", "This Browser capability is not enabled."],
  [
    "ADVANCED_BROWSER_MODE_REQUIRED",
    "browserErrorAdvancedRequired",
    "Advanced Browser Mode is required for this action.",
  ],
  ["PERMISSION_DENIED", "browserErrorPermissionDenied", "The Browser permission was denied."],
  ["ACTION_TIMEOUT", "browserErrorActionTimeout", "The Browser action timed out."],
  [
    "JAVASCRIPT_EXECUTION_FAILED",
    "browserErrorJavaScriptFailed",
    "The Browser JavaScript failed; correct the script before trying again.",
  ],
  ["NAVIGATION_BLOCKED", "browserErrorNavigationBlocked", "Browser navigation was blocked by policy."],
  ["NAVIGATION_FAILED", "browserErrorNavigationFailed", "Browser navigation failed; follow the recovery guidance."],
  ["INSPECTION_STALE", "browserErrorInspectionStale", "The page changed during inspection; inspect it again."],
  ["BROWSER_RETRY_BLOCKED", "browserErrorRetryBlocked", "An ineffective retry of the same failure was blocked."],
  [
    "BROWSER_ROUTE_BYPASS_BLOCKED",
    "browserErrorRouteBypassBlocked",
    "Another network route requires local approval after Browser policy denied the target.",
  ],
  [
    "BROWSER_REPLAN_REQUIRED",
    "browserErrorReplanRequired",
    "The Browser call checkpoint was reached; summarize evidence and replan.",
  ],
  [
    "BROWSER_CALL_BUDGET_EXCEEDED",
    "browserErrorBudgetExceeded",
    "The Browser call budget is exhausted; a local user must continue.",
  ],
];

export function browserErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const match = ERROR_COPY.find(([code]) => message.includes(code));
  return match
    ? translate(match[1], match[2])
    : translate("browserUnexpectedError", "The Browser operation could not be completed.");
}
