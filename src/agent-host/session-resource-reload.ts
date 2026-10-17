import type { AgentSessionLike } from "../shared/pi-types";

/** One reload owns resource replacement. Failed reloads require an explicit retry instead of a partial bind. */
export class SessionResourceReload {
  private pending?: Promise<void>;
  private failure?: { error: unknown };
  private mutating = false;
  executionReady(): boolean {
    return !this.mutating && !this.failure;
  }
  run(action: () => Promise<void | (() => Promise<void>)>): Promise<void> {
    if (this.pending) return this.pending;
    const pending = Promise.resolve()
      .then(action)
      .then(
        (afterResources) => {
          this.failure = undefined;
          this.mutating = false;
          // Model/auth recovery can still need user input without invalidating the rebuilt tools.
          if (typeof afterResources === "function") return afterResources();
        },
        (error) => {
          this.failure = { error };
          throw error;
        },
      )
      .finally(() => {
        this.mutating = false;
        if (this.pending === pending) this.pending = undefined;
      });
    this.pending = pending;
    return pending;
  }
  async ready(): Promise<void> {
    if (this.pending) await this.pending;
    if (this.failure) throw this.failure.error;
  }

  /** SDK settings reload precedes this public hook; bound extensions then start exactly once. */
  async reloadSession(
    session: AgentSessionLike,
    refresh: (() => Promise<void>) | undefined,
    prepare: () => void,
    alive: () => boolean,
  ): Promise<boolean> {
    if (session.isStreaming || session.isCompacting) await session.waitForIdle();
    const assertAlive = () => {
      if (!alive()) throw new Error("Agent session is no longer available");
    };
    assertAlive();
    this.mutating = true;
    const prepareResources = async () => {
      assertAlive();
      await refresh?.();
      assertAlive();
      prepare();
    };
    let started = false;
    await session.reload({
      beforeSessionStart: async () => {
        await prepareResources();
        started = true;
      },
    });
    // A session without existing SDK bindings does not invoke beforeSessionStart; bind after preparing it.
    if (!started) await prepareResources();
    return started;
  }
}
