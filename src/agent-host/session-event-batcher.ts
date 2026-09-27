export type SessionStreamEvent = { type: string; [key: string]: unknown };

export interface SessionEventBatchOptions {
  intervalMs?: number;
  now?: () => number;
  schedule?: (flush: () => void, delay: number) => () => void;
}

/** Complete snapshots remain reconnectable; intermediate updates are bounded to 20 Hz. */
export class SessionEventBatcher {
  private readonly emit: (event: SessionStreamEvent) => void;
  private readonly options: Required<SessionEventBatchOptions>;
  private pending: SessionStreamEvent | null = null;
  private cancelTimer: (() => void) | null = null;
  private lastSent = -Infinity;
  private closed = false;

  constructor(emit: (event: SessionStreamEvent) => void, options: SessionEventBatchOptions = {}) {
    this.emit = emit;
    this.options = {
      intervalMs: options.intervalMs ?? 50,
      now: options.now ?? (() => performance.now()),
      schedule:
        options.schedule ??
        ((flush, delay) => {
          const timer = setTimeout(flush, delay);
          return () => clearTimeout(timer);
        }),
    };
  }

  push(event: SessionStreamEvent): void {
    if (this.closed) return;
    if (event.type !== "message_update") {
      this.flush();
      this.emit(event);
      if (event.type === "message_start") this.lastSent = -Infinity;
      return;
    }
    const { assistantMessageEvent: _unused, ...snapshot } = event;
    this.pending = snapshot;
    const remaining = this.options.intervalMs - (this.options.now() - this.lastSent);
    if (remaining <= 0) this.flush();
    else if (!this.cancelTimer) this.cancelTimer = this.options.schedule(() => this.flush(), remaining);
  }

  dispose(): void {
    this.closed = true;
    this.cancelTimer?.();
    this.cancelTimer = null;
    this.pending = null;
  }

  private flush(): void {
    this.cancelTimer?.();
    this.cancelTimer = null;
    const event = this.pending;
    this.pending = null;
    if (event && !this.closed) {
      this.lastSent = this.options.now();
      this.emit(event);
    }
  }
}
