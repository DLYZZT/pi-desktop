type ReplayEntry<T> = {
  generation: number;
  value: T;
  expiresAt: number;
};

export class EarlyEventReplay<T> {
  private readonly listeners = new Set<(value: T) => void>();
  private readonly ttlMs: number;
  private readonly now: () => number;
  private generation = 0;
  private pending: ReplayEntry<T> | null = null;

  constructor(ttlMs = 30_000, now: () => number = Date.now) {
    this.ttlMs = ttlMs;
    this.now = now;
  }

  emit(value: T): void {
    this.generation += 1;
    if (this.listeners.size === 0) {
      this.pending = { generation: this.generation, value, expiresAt: this.now() + this.ttlMs };
      return;
    }
    this.pending = null;
    for (const listener of [...this.listeners]) this.deliver(listener, value);
  }

  subscribe(listener: (value: T) => void): () => void {
    this.listeners.add(listener);
    const pending = this.pending;
    if (pending) {
      if (pending.expiresAt > this.now() && pending.generation === this.generation) {
        this.deliver(listener, pending.value);
      } else {
        this.pending = null;
      }
    }
    return () => this.listeners.delete(listener);
  }

  private deliver(listener: (value: T) => void, value: T): void {
    try {
      listener(value);
    } catch {
      /* isolate renderer listener failures */
    }
  }
}
