import { ModelRuntime } from "@earendil-works/pi-coding-agent";

let sharedRuntimePromise: Promise<ModelRuntime> | undefined;

/**
 * Shared runtime for host-level model and credential management.
 *
 * Agent sessions keep their own cwd-bound runtimes so project extensions
 * cannot leak provider registrations into unrelated sessions.
 */
export function getSharedModelRuntime(): Promise<ModelRuntime> {
  if (!sharedRuntimePromise) {
    sharedRuntimePromise = ModelRuntime.create().catch((error) => {
      sharedRuntimePromise = undefined;
      throw error;
    });
  }
  return sharedRuntimePromise;
}

/** Reload models.json only when the shared runtime has already been created. */
export async function reloadSharedModelRuntimeConfig(): Promise<void> {
  if (!sharedRuntimePromise) return;
  const runtime = await sharedRuntimePromise;
  await runtime.reloadConfig();
}
