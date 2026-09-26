export type HostShutdownStep = { name: string; stop: () => void | Promise<unknown> };

/** Preserve order, attempt every release, and return one shared completion. */
export function createHostShutdown(steps: readonly HostShutdownStep[]): () => Promise<void> {
  let completion: Promise<void> | undefined;
  return () => {
    if (completion) return completion;
    let resolve!: () => void, reject!: (error: unknown) => void;
    completion = new Promise<void>((done, failed) => {
      resolve = done;
      reject = failed;
    });
    void (async () => {
      const errors: unknown[] = [],
        names: string[] = [];
      for (const step of steps) {
        try {
          const pending = step.stop();
          // Synchronous subscription detaches finish before this call returns.
          if (pending && typeof pending.then === "function") await pending;
        } catch (error) {
          errors.push(error);
          names.push(step.name);
        }
      }
      if (errors.length) throw new AggregateError(errors, "Host cleanup failed: " + names.join(", "));
    })().then(resolve, reject);
    return completion;
  };
}
