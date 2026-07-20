import type { ToolCapabilityId, ToolchainErrorCode } from "./types";

export interface ToolchainErrorOptions {
  code: ToolchainErrorCode;
  message: string;
  capability?: ToolCapabilityId;
  causeCode?: string;
  detail?: Record<string, unknown>;
  cause?: unknown;
}

export class ToolchainError extends Error {
  readonly code: ToolchainErrorCode;
  readonly capability?: ToolCapabilityId;
  readonly causeCode?: string;
  readonly detail?: Record<string, unknown>;

  constructor(options: ToolchainErrorOptions) {
    super(options.message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "ToolchainError";
    this.code = options.code;
    this.capability = options.capability;
    this.causeCode = options.causeCode;
    this.detail = options.detail;
  }
}

export function toolchainCauseCode(error: unknown): string | undefined {
  if (!error || typeof error !== "object") return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" && code.length <= 64 ? code : undefined;
}

export function asToolchainError(
  error: unknown,
  fallback: Omit<ToolchainErrorOptions, "cause" | "causeCode">,
): ToolchainError {
  if (error instanceof ToolchainError) return error;
  return new ToolchainError({
    ...fallback,
    cause: error,
    causeCode: toolchainCauseCode(error),
  });
}

export function publicToolchainError(error: unknown): {
  code: ToolchainErrorCode;
  message: string;
} {
  if (error instanceof ToolchainError) {
    return { code: error.code, message: error.message };
  }
  return {
    code: "TOOLCHAIN_INTERNAL",
    message: error instanceof Error ? error.message : "Unknown toolchain error",
  };
}
