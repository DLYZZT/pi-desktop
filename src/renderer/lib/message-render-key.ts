export type MessageRenderRole = "message" | "process" | "process-final" | "final";

export class MessageRenderKeyRegistry {
  private readonly localKeys = new WeakMap<object, string>();
  private nextLocalId = 0;

  keyFor(message: object, entryId: string | undefined, role: MessageRenderRole): string {
    const base = entryId ? `entry:${entryId}` : this.localKeyFor(message);
    return `${base}:${role}`;
  }

  private localKeyFor(message: object): string {
    const existing = this.localKeys.get(message);
    if (existing) return existing;
    const created = `local:${++this.nextLocalId}`;
    this.localKeys.set(message, created);
    return created;
  }
}
