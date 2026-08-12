import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { ModelsRefreshResult } from "@earendil-works/pi-ai";
import type { ModelCatalogStatus, ModelCatalogWarning } from "../contract/types";

export const MODEL_CATALOG_REFRESH_TIMEOUT_MS = 12_000;

type RefreshableRuntime = {
  refresh(options: { allowNetwork?: boolean; force?: boolean; signal?: AbortSignal }): Promise<ModelsRefreshResult>;
};

type RuntimeServices = { modelRuntime: RefreshableRuntime };

export type ModelCatalogRefreshOutcome<T extends RuntimeServices> = {
  services: T;
  catalog: ModelCatalogStatus;
};

type ModelCatalogRefreshProjector<T extends RuntimeServices, R> = (
  outcome: ModelCatalogRefreshOutcome<T>,
  signal: AbortSignal,
) => R | Promise<R>;

type ActiveRefresh = {
  requestId: string;
  cwd: string;
  controller: AbortController;
  abortKind?: "cancelled" | "replaced" | "timeout";
};

type ModelCatalogTimers = Pick<typeof globalThis, "setTimeout" | "clearTimeout">;

export class ModelCatalogRefreshAbortedError extends Error {
  constructor(readonly kind: "cancelled" | "replaced" | "timeout") {
    super(kind === "timeout" ? "Model catalog refresh timed out" : "Model catalog refresh was cancelled");
    this.name = "ModelCatalogRefreshAbortedError";
  }
}

function providerWarnings(errors: ReadonlyMap<string, Error>): ModelCatalogWarning[] {
  return [...errors.keys()]
    .sort((a, b) => a.localeCompare(b))
    .map((provider) => ({
      provider,
      code: "PROVIDER_REFRESH_FAILED" as const,
      message: `Unable to refresh the ${provider} model catalog; cached models remain available.`,
    }));
}

export class ModelCatalogRefreshCoordinator {
  private readonly byRequestId = new Map<string, ActiveRefresh>();
  private readonly byCwd = new Map<string, ActiveRefresh>();

  constructor(
    private readonly timeoutMs = MODEL_CATALOG_REFRESH_TIMEOUT_MS,
    private readonly isOffline: () => boolean = () => process.env.PI_OFFLINE !== undefined,
    private readonly timers: ModelCatalogTimers = globalThis,
  ) {}

  async refresh<T extends RuntimeServices>(
    cwd: string,
    requestId: string,
    createServices: (signal: AbortSignal) => Promise<T>,
  ): Promise<ModelCatalogRefreshOutcome<T>>;
  async refresh<T extends RuntimeServices, R>(
    cwd: string,
    requestId: string,
    createServices: (signal: AbortSignal) => Promise<T>,
    project: ModelCatalogRefreshProjector<T, R>,
  ): Promise<R>;
  async refresh<T extends RuntimeServices, R>(
    cwd: string,
    requestId: string,
    createServices: (signal: AbortSignal) => Promise<T>,
    project?: ModelCatalogRefreshProjector<T, R>,
  ): Promise<ModelCatalogRefreshOutcome<T> | R> {
    this.abort(this.byRequestId.get(requestId), "replaced");
    this.abort(this.byCwd.get(cwd), "replaced");

    const active: ActiveRefresh = {
      requestId,
      cwd,
      controller: new AbortController(),
    };
    this.byRequestId.set(requestId, active);
    this.byCwd.set(cwd, active);

    const timer = this.timers.setTimeout(() => this.abort(active, "timeout"), this.timeoutMs);
    let services: T | undefined;
    const abortedMarker = Symbol("model-catalog-refresh-aborted");
    const aborted = new Promise<typeof abortedMarker>((resolve) => {
      active.controller.signal.addEventListener("abort", () => resolve(abortedMarker), { once: true });
    });
    const finish = async (outcome: ModelCatalogRefreshOutcome<T>): Promise<ModelCatalogRefreshOutcome<T> | R> =>
      project ? project(outcome, active.controller.signal) : outcome;

    try {
      const operation = (async () => {
        services = await createServices(active.controller.signal);
        if (active.controller.signal.aborted)
          throw new ModelCatalogRefreshAbortedError(active.abortKind ?? "cancelled");
        if (this.isOffline()) {
          return finish({
            services,
            catalog: { source: "offline", refreshed: false, aborted: false, warnings: [] } satisfies ModelCatalogStatus,
          });
        }

        const result = await services.modelRuntime.refresh({
          allowNetwork: true,
          force: true,
          signal: active.controller.signal,
        });
        return finish({
          services,
          catalog: {
            source: "network",
            refreshed: !result.aborted,
            aborted: result.aborted,
            warnings: providerWarnings(result.errors),
          } satisfies ModelCatalogStatus,
        });
      })();
      const outcome = await Promise.race([operation, aborted]);
      if (outcome !== abortedMarker) return outcome;
      if (!services) throw new ModelCatalogRefreshAbortedError(active.abortKind ?? "cancelled");
      const timedOut = active.abortKind === "timeout";
      return finish({
        services,
        catalog: {
          source: "network",
          refreshed: false,
          aborted: true,
          warnings: timedOut
            ? [
                {
                  provider: "*",
                  code: "MODEL_REFRESH_TIMEOUT",
                  message: `Model catalog refresh timed out after ${this.timeoutMs}ms; cached models remain available.`,
                },
              ]
            : [],
        },
      });
    } finally {
      this.timers.clearTimeout(timer);
      if (this.byRequestId.get(requestId) === active) this.byRequestId.delete(requestId);
      if (this.byCwd.get(cwd) === active) this.byCwd.delete(cwd);
    }
  }

  cancel(requestId: string): boolean {
    const active = this.byRequestId.get(requestId);
    if (!active) return false;
    this.abort(active, "cancelled");
    return true;
  }

  cancelAll(): void {
    for (const active of this.byRequestId.values()) this.abort(active, "cancelled");
    this.byRequestId.clear();
    this.byCwd.clear();
  }

  private abort(active: ActiveRefresh | undefined, kind: NonNullable<ActiveRefresh["abortKind"]>): void {
    if (!active || active.controller.signal.aborted) return;
    active.abortKind = kind;
    active.controller.abort();
  }
}

export const modelCatalogRefreshCoordinator = new ModelCatalogRefreshCoordinator();

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

/** Refresh local model configuration/cache only when the shared runtime already exists. */
export async function reloadSharedModelRuntimeConfig(): Promise<void> {
  if (!sharedRuntimePromise) return;
  const runtime = await sharedRuntimePromise;
  await runtime.refresh({ allowNetwork: false });
}
