interface DirectoryRefreshOptions<T> {
  read: () => Promise<T>;
  apply: (value: T) => void;
  onError: (error: unknown) => void;
  onLoading: (loading: boolean) => void;
  onInvalidate: () => void;
}

/** One directory lifetime: serialize reads and defer collapsed-directory work. */
export class DirectoryRefreshCoordinator<T> {
  private readonly options: DirectoryRefreshOptions<T>;
  private enabled = false;
  private dirty = true;
  private closed = false;
  private pending: Promise<void> | null = null;

  constructor(options: DirectoryRefreshOptions<T>) {
    this.options = options;
  }

  setEnabled(enabled: boolean): Promise<void> {
    this.enabled = enabled;
    return this.drain();
  }

  invalidate(): Promise<void> {
    if (this.closed) return Promise.resolve();
    this.dirty = true;
    this.options.onInvalidate();
    return this.drain();
  }

  dispose(): void {
    this.closed = true;
    this.dirty = false;
  }

  private drain(): Promise<void> {
    if (this.pending) return this.pending;
    if (this.closed || !this.enabled || !this.dirty) return Promise.resolve();
    this.pending = Promise.resolve().then(async () => {
      try {
        if (this.closed) return;
        this.options.onLoading(true);
        while (!this.closed && this.enabled && this.dirty) {
          this.dirty = false;
          let value: T;
          try {
            value = await this.options.read();
          } catch (error) {
            if (this.closed) break;
            if (this.dirty) continue;
            // Retry on the next expansion or explicit refresh, never in a loop.
            this.dirty = true;
            this.options.onError(error);
            break;
          }
          if (this.closed) break;
          if (this.dirty) continue;
          this.options.apply(value);
        }
      } finally {
        this.pending = null;
        if (!this.closed) this.options.onLoading(false);
      }
    });
    return this.pending;
  }
}
