export class ThinkingExpansionStore {
  private readonly values = new Map<string, boolean>();
  private readonly listeners = new Set<() => void>();
  private defaultExpanded = false;
  private readonly maxEntries: number;

  constructor(maxEntries = 500) {
    this.maxEntries = maxEntries;
  }

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = (key: string): boolean => {
    if (this.values.has(key)) return this.values.get(key)!;
    // Capture the default on first observation. Later toggles may change the
    // default for newly mounted blocks, but must not silently flip blocks that
    // are already rendered and have never been clicked.
    const initial = this.defaultExpanded;
    this.values.set(key, initial);
    this.prune();
    return initial;
  };

  toggle(key: string): void {
    const next = !this.getSnapshot(key);
    this.values.delete(key);
    this.values.set(key, next);
    this.defaultExpanded = next;
    this.prune();
    this.emit();
  }

  clear(): void {
    if (this.values.size === 0 && !this.defaultExpanded) return;
    this.values.clear();
    this.defaultExpanded = false;
    this.emit();
  }

  sizeForTest(): number {
    return this.values.size;
  }

  keysForTest(): string[] {
    return [...this.values.keys()];
  }

  private emit(): void {
    for (const listener of this.listeners) listener();
  }

  private prune(): void {
    while (this.values.size > this.maxEntries) {
      const oldest = this.values.keys().next().value;
      if (oldest === undefined) break;
      this.values.delete(oldest);
    }
  }
}

export class ThinkingExpansionRegistry {
  private readonly stores = new Map<string, ThinkingExpansionStore>();
  private readonly maxSessions: number;
  private readonly maxEntriesPerSession: number;

  constructor(maxSessions = 20, maxEntriesPerSession = 500) {
    this.maxSessions = maxSessions;
    this.maxEntriesPerSession = maxEntriesPerSession;
  }

  get(sessionId: string): ThinkingExpansionStore {
    const existing = this.stores.get(sessionId);
    if (existing) {
      this.stores.delete(sessionId);
      this.stores.set(sessionId, existing);
      return existing;
    }
    const store = new ThinkingExpansionStore(this.maxEntriesPerSession);
    this.stores.set(sessionId, store);
    while (this.stores.size > this.maxSessions) {
      const oldestSessionId = this.stores.keys().next().value;
      if (oldestSessionId === undefined) break;
      this.stores.get(oldestSessionId)?.clear();
      this.stores.delete(oldestSessionId);
    }
    return store;
  }

  delete(sessionId: string): void {
    this.stores.get(sessionId)?.clear();
    this.stores.delete(sessionId);
  }

  sizeForTest(): number {
    return this.stores.size;
  }
}
