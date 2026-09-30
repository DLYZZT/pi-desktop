import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { ExecutionLogStore } from "../execution-log-store";
import type { ExecutionPayload } from "../../contract/executions";

/** Settings previews are a bounded, temporary cache. Actual tool results live in their session's journal. */
export class McpResourcePreviews {
  readonly root = path.join(tmpdir(), `pi-desktop-mcp-preview-${randomUUID()}`);
  private readonly store = new ExecutionLogStore("previews", this.root);
  private readonly retained = new Map<string, number>();
  private queue: Promise<unknown> = Promise.resolve();
  private disposed = false;
  constructor(private readonly maxBytes = 64 * 1024 * 1024) {}
  payload(value: unknown): Promise<ExecutionPayload> {
    const work = this.queue.then(async () => {
      if (this.disposed) throw new Error("MCP preview cache is closed");
      const payload = await this.store.payload(value);
      if (payload.ref) {
        this.retained.delete(payload.ref.hash);
        this.retained.set(payload.ref.hash, payload.ref.bytes);
        let total = [...this.retained.values()].reduce((sum, bytes) => sum + bytes, 0);
        while (total > this.maxBytes && this.retained.size) {
          const [hash, bytes] = this.retained.entries().next().value!;
          this.retained.delete(hash);
          total -= bytes;
          await rm(path.join(this.root, "tool-executions", "previews", "content", `${hash}.json`), { force: true });
        }
      }
      return payload;
    });
    this.queue = work.catch(() => undefined);
    return work;
  }
  async content(hash: string, offset?: number) {
    await this.queue;
    if (this.disposed || !this.retained.has(hash)) throw new Error("MCP preview expired; read the resource again");
    return this.store.readContentChunk(hash, offset ?? 0, 65536);
  }
  async dispose(): Promise<void> {
    this.disposed = true;
    await this.queue;
    this.retained.clear();
    await rm(this.root, { recursive: true, force: true });
  }
}
