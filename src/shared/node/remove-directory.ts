import { rm } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";

const RETRYABLE = new Set(["EBUSY", "ENOTEMPTY", "EPERM", "EACCES"]);

/** Retry the whole operation, without multiplying synchronous retries at each directory depth. */
export async function removeDirectoryWithRetry(
  directory: string,
  remove: typeof rm = rm,
  pause: () => Promise<void> = () => delay(100),
): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await remove(directory, { recursive: true, force: true, maxRetries: 0 });
      return;
    } catch (error) {
      if (!RETRYABLE.has((error as NodeJS.ErrnoException).code ?? "") || attempt >= 20) throw error;
      await pause();
    }
  }
}
