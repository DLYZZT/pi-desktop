type Schedule = (run: () => Promise<void>, delay: number) => () => void;

/** Coalesce persisted-history notifications without losing a change during an active read. */
export class SessionRefreshQueue {
  private cancelTimer: (() => void) | null = null;
  private reading = false;
  private dirty = false;
  private closed = false;
  private delay = 0;
  private readonly read: () => unknown | Promise<unknown>;
  private readonly schedule: Schedule;

  constructor(
    read: () => unknown | Promise<unknown>,
    schedule: Schedule = (run, delay) => {
      const timer = setTimeout(() => void run(), delay);
      return () => clearTimeout(timer);
    },
  ) {
    this.read = read;
    this.schedule = schedule;
  }

  request(delay: number): void {
    if (this.closed) return;
    this.dirty = true;
    this.delay = delay;
    if (this.reading) return;
    if (delay === 0) {
      this.cancelTimer?.();
      this.cancelTimer = null;
      void this.run();
    } else if (!this.cancelTimer) {
      this.cancelTimer = this.schedule(() => this.run(), delay);
    }
  }

  cancel(): void {
    this.cancelTimer?.();
    this.cancelTimer = null;
    this.dirty = false;
  }

  dispose(): void {
    this.closed = true;
    this.cancel();
  }

  private async run(): Promise<void> {
    this.cancelTimer = null;
    if (this.closed || !this.dirty || this.reading) return;
    this.dirty = false;
    this.reading = true;
    try {
      const result = this.read();
      if (result && typeof (result as Promise<unknown>).then === "function") await (result as Promise<unknown>);
    } catch {
      // History reads own their error UI; a later notification can retry.
    } finally {
      this.reading = false;
      if (this.dirty && !this.closed) this.request(this.delay);
    }
  }
}
