import { translate } from "../../i18n.ts";

export function browserErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes("USER_DENIED")) return translate("browserErrorUserDenied", "Browser access was denied.");
  if (message.includes("AUTHORIZATION_TIMEOUT")) {
    return translate("browserErrorAuthorizationTimeout", "Browser authorization timed out.");
  }
  if (message.includes("BROWSER_DISABLED")) {
    return translate("browserErrorDisabled", "The built-in Browser is disabled.");
  }
  if (message.includes("CAPABILITY_DISABLED")) {
    return translate("browserErrorCapabilityDisabled", "This Browser capability is not enabled.");
  }
  if (message.includes("ADVANCED_BROWSER_MODE_REQUIRED")) {
    return translate("browserErrorAdvancedRequired", "Advanced Browser Mode is required for this action.");
  }
  if (message.includes("PERMISSION_DENIED")) {
    return translate("browserErrorPermissionDenied", "The Browser permission was denied.");
  }
  if (message.includes("ACTION_TIMEOUT")) {
    return translate("browserErrorActionTimeout", "The Browser action timed out.");
  }
  if (message.includes("JAVASCRIPT_EXECUTION_FAILED")) {
    return translate(
      "browserErrorJavaScriptFailed",
      "The Browser JavaScript failed; correct the script before trying again.",
    );
  }
  if (message.includes("NAVIGATION_BLOCKED")) {
    return translate("browserErrorNavigationBlocked", "Browser navigation was blocked by policy.");
  }
  if (message.includes("NAVIGATION_FAILED")) {
    return translate("browserErrorNavigationFailed", "Browser navigation failed; follow the recovery guidance.");
  }
  if (message.includes("INSPECTION_STALE")) {
    return translate("browserErrorInspectionStale", "The page changed during inspection; inspect it again.");
  }
  if (message.includes("BROWSER_RETRY_BLOCKED")) {
    return translate("browserErrorRetryBlocked", "An ineffective retry of the same failure was blocked.");
  }
  if (message.includes("BROWSER_ROUTE_BYPASS_BLOCKED")) {
    return translate(
      "browserErrorRouteBypassBlocked",
      "Another network route requires local approval after Browser policy denied the target.",
    );
  }
  if (message.includes("BROWSER_REPLAN_REQUIRED")) {
    return translate(
      "browserErrorReplanRequired",
      "The Browser call checkpoint was reached; summarize evidence and replan.",
    );
  }
  if (message.includes("BROWSER_CALL_BUDGET_EXCEEDED")) {
    return translate("browserErrorBudgetExceeded", "The Browser call budget is exhausted; a local user must continue.");
  }
  return translate("browserUnexpectedError", "The Browser operation could not be completed.");
}
