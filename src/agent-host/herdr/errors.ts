import type { HerdrErrorCode, HerdrPublicError } from "../../contract/herdr";

export class HerdrBridgeError extends Error {
  readonly code: HerdrErrorCode;
  readonly retryable: boolean;
  readonly upgradeRequired: boolean;
  readonly action?: HerdrPublicError["action"];
  readonly detail?: HerdrPublicError["detail"];

  constructor(
    code: HerdrErrorCode,
    message: string,
    retryable = false,
    upgradeRequired = false,
    options: Pick<HerdrPublicError, "action" | "detail"> = {},
  ) {
    super(message);
    this.name = "HerdrBridgeError";
    this.code = code;
    this.retryable = retryable;
    this.upgradeRequired = upgradeRequired;
    this.action = options.action;
    this.detail = options.detail;
  }

  toPublic(): HerdrPublicError {
    return {
      code: this.code,
      message: this.message,
      retryable: this.retryable,
      ...(this.action ? { action: this.action } : {}),
      ...(this.detail ? { detail: this.detail } : {}),
      ...(this.upgradeRequired ? { upgradeRequired: true } : {}),
    };
  }
}

export function asHerdrError(error: unknown): HerdrBridgeError {
  if (error instanceof HerdrBridgeError) return error;
  return new HerdrBridgeError("HERDR_INTERNAL", "Unexpected Herdr integration error");
}
