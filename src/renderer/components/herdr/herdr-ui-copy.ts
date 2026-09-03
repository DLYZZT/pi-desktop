import type { HerdrPublicError, HerdrRuntimeStatus } from "@contract/herdr";

type Translate = (key: string, fallback: string) => string;

export function herdrRuntimeStatusLabel(status: HerdrRuntimeStatus | undefined, t: Translate): string {
  if (status === "disabled") return t("herdrStatusDisabled", "Disabled");
  if (status === "probing") return t("herdrStatusProbing", "Checking runtime");
  if (status === "starting") return t("herdrStatusStarting", "Starting Session");
  if (status === "connecting") return t("herdrStatusConnecting", "Connecting");
  if (status === "ready") return t("herdrStatusReady", "Connected");
  if (status === "degraded") return t("herdrStatusDegraded", "Read-only connection");
  if (status === "reconnecting") return t("herdrStatusReconnecting", "Reconnecting");
  if (status === "incompatible") return t("herdrStatusIncompatible", "Incompatible runtime");
  if (status === "error") return t("herdrStatusError", "Runtime error");
  return t("herdrStatusUnavailable", "Unavailable");
}

export function herdrErrorLabel(error: unknown, t: Translate): string {
  const code = errorCode(error);
  if (code === "HERDR_BINARY_NOT_FOUND" || code === "HERDR_AGENT_BINARY_MISSING")
    return t("herdrErrorBinaryMissing", "A required Herdr or Agent executable is unavailable.");
  if (code === "HERDR_BINARY_INTEGRITY_FAILED" || code === "HERDR_SCHEMA_INVALID")
    return t("herdrErrorIntegrity", "Herdr failed a compatibility or integrity check.");
  if (code === "HERDR_VERSION_TOO_OLD" || code === "HERDR_PROTOCOL_UNSUPPORTED" || code === "HERDR_SCHEMA_UNSUPPORTED")
    return t("herdrErrorUpgrade", "This Herdr version is incompatible. Update Herdr in Developer Tools.");
  if (code === "HERDR_ENDPOINT_UNSAFE")
    return t("herdrErrorUnsafeEndpoint", "The Herdr Session endpoint did not pass local security checks.");
  if (code === "HERDR_ENDPOINT_UNAVAILABLE" || code === "HERDR_SESSION_NOT_FOUND")
    return t("herdrErrorUnavailable", "The selected Herdr Session is unavailable.");
  if (code === "HERDR_SERVER_CONFLICT")
    return t("herdrErrorConflict", "Another process already owns this Herdr Session.");
  if (code === "HERDR_REQUEST_TIMEOUT") return t("herdrErrorTimeout", "The Herdr operation timed out. Try again.");
  if (code === "HERDR_REQUEST_CANCELLED") return t("herdrErrorCancelled", "The Herdr operation was cancelled.");
  if (code === "HERDR_CONFIRMATION_REQUIRED")
    return t("herdrErrorConfirmationRequired", "This Herdr operation requires an interactive local confirmation.");
  if (code === "HERDR_AGENT_BLOCKED")
    return t("herdrErrorAgentBlocked", "The Agent needs attention before it can continue.");
  if (code === "HERDR_CONTROLLER_LOST")
    return t("herdrErrorControllerLost", "Terminal control was lost. Reconnect in Observe mode.");
  if (code === "HERDR_TERMINAL_STREAM_INVALID" || code === "HERDR_TERMINAL_PROTOCOL")
    return t("herdrErrorTerminalStream", "The terminal stream became invalid and was reset to Observe mode.");
  return t("herdrErrorGeneric", "The Herdr operation failed. Try again or open diagnostics.");
}

export function publicHerdrErrorLabel(error: HerdrPublicError | undefined, t: Translate): string | null {
  return error ? herdrErrorLabel(error, t) : null;
}

function errorCode(error: unknown): string | undefined {
  if (error && typeof error === "object" && !Array.isArray(error)) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === "string") return code;
  }
  const message = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  return message.match(/\bHERDR_[A-Z_]+\b/u)?.[0];
}
