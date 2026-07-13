export class LaneScheduler {
  private readonly tails = new Map<string, Promise<void>>();
  private readonly waiters: Array<() => void> = [];
  private active = 0;

  constructor(private readonly maxConcurrent = 4) {
    if (!Number.isInteger(maxConcurrent) || maxConcurrent < 1) throw new Error("maxConcurrent must be positive");
  }

  private acquire(): Promise<void> {
    if (this.active < this.maxConcurrent) {
      this.active += 1;
      return Promise.resolve();
    }
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  private release(): void {
    const next = this.waiters.shift();
    if (next) next();
    else this.active = Math.max(0, this.active - 1);
  }

  run<T>(key: string, task: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.catch(() => undefined).then(() => gate);
    this.tails.set(key, tail);

    return previous
      .catch(() => undefined)
      .then(async () => {
        await this.acquire();
        try {
          return await task();
        } finally {
          this.release();
        }
      })
      .finally(() => {
        release();
        if (this.tails.get(key) === tail) this.tails.delete(key);
      });
  }

  size(): number {
    return this.tails.size;
  }
}
