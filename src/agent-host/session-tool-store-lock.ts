import { mkdirSync } from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import lockfile from "proper-lockfile";

/** Mutations run synchronously under the file lock. Only contention yields the Host event loop. */
export class SessionToolStoreLock {
  private held = false;
  private tail?: Promise<void>;
  constructor(private readonly file: string) {}
  get isHeld(): boolean {
    return this.held;
  }

  run<T>(change: () => T): T | Promise<T> {
    if (this.held) return change();
    mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    if (!this.tail) {
      const release = this.acquire();
      if (release) return this.apply(release, change);
    }
    return this.enqueue(async () => this.apply(await this.waitForLock(), change));
  }

  /** Keep the lease alive while inspecting other stores. Only the synchronous final change can reenter the lock. */
  prepareThenRun<T>(prepare: () => Promise<T>, change: (result: T) => void): Promise<void> {
    mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    return this.enqueue(async () => {
      const release = await this.waitForLock();
      let prepared: T;
      try {
        prepared = await prepare();
      } catch (error) {
        this.release(release);
        throw error;
      }
      this.apply(release, () => change(prepared));
    });
  }

  private enqueue<T>(work: () => Promise<T>): Promise<T> {
    const pending = this.tail ? this.tail.then(work) : work();
    const tail = pending.then(
      () => undefined,
      () => undefined,
    );
    this.tail = tail;
    void tail.then(() => {
      if (this.tail === tail) this.tail = undefined;
    });
    return pending;
  }

  private acquire(): (() => void) | undefined {
    try {
      return lockfile.lockSync(this.file, { realpath: false });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ELOCKED") throw error;
    }
  }

  private async waitForLock(): Promise<() => void> {
    const deadline = Date.now() + 30_000;
    for (let ms = 10; ; ms = Math.min(ms * 2, 250)) {
      const release = this.acquire();
      if (release) return release;
      if (Date.now() >= deadline)
        throw Object.assign(new Error("Timed out waiting for Desktop tool permissions"), { code: "ELOCKED" });
      await delay(ms);
    }
  }

  private apply<T>(release: () => void, change: () => T): T {
    this.held = true;
    try {
      return change();
    } finally {
      this.held = false;
      this.release(release);
    }
  }

  private release(release: () => void): void {
    try {
      release();
    } catch (error) {
      console.warn("[agent-host] failed to release tool permissions lock:", error);
    }
  }
}
