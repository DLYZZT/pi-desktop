export type RendererCrashAction =
  { kind: "ignore" } | { kind: "reload"; attempt: number; delayMs: number } | { kind: "halt"; reason: string };

export type RendererCrashRecoveryOptions = {
  baseDelayMs?: number;
  maxDelayMs?: number;
  maxReloads?: number;
  now?: () => number;
  windowMs?: number;
};

const NON_RECOVERABLE_REASONS = new Set(["oom", "launch-failed", "integrity-failure"]);
const IGNORED_REASONS = new Set(["clean-exit", "killed"]);

export class RendererCrashRecovery {
  private readonly baseDelayMs: number;
  private readonly maxDelayMs: number;
  private readonly maxReloads: number;
  private readonly now: () => number;
  private readonly windowMs: number;
  private reloads: number[] = [];

  constructor(options: RendererCrashRecoveryOptions = {}) {
    this.baseDelayMs = options.baseDelayMs ?? 250;
    this.maxDelayMs = options.maxDelayMs ?? 4_000;
    this.maxReloads = options.maxReloads ?? 3;
    this.now = options.now ?? Date.now;
    this.windowMs = options.windowMs ?? 60_000;
  }

  record(reason: string): RendererCrashAction {
    if (IGNORED_REASONS.has(reason)) return { kind: "ignore" };
    if (NON_RECOVERABLE_REASONS.has(reason)) return { kind: "halt", reason };

    const now = this.now();
    this.reloads = this.reloads.filter((timestamp) => now - timestamp < this.windowMs);
    if (this.reloads.length >= this.maxReloads) return { kind: "halt", reason: "crash-loop" };

    this.reloads.push(now);
    const attempt = this.reloads.length;
    return {
      kind: "reload",
      attempt,
      delayMs: Math.min(this.maxDelayMs, this.baseDelayMs * 2 ** (attempt - 1)),
    };
  }

  reset(): void {
    this.reloads = [];
  }
}
