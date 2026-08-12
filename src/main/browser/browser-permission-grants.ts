export class BrowserPermissionGrantStore {
  private readonly sessionKeys = new Set<string>();
  private readonly onceKeys = new Set<string>();

  allowSession(key: string): void {
    this.sessionKeys.add(key);
    this.onceKeys.delete(key);
  }

  allowOnce(key: string): void {
    if (!this.sessionKeys.has(key)) this.onceKeys.add(key);
  }

  peek(key: string): boolean {
    return this.sessionKeys.has(key) || this.onceKeys.has(key);
  }

  consume(key: string): boolean {
    if (this.sessionKeys.has(key)) return true;
    return this.onceKeys.delete(key);
  }

  clear(): void {
    this.sessionKeys.clear();
    this.onceKeys.clear();
  }
}
