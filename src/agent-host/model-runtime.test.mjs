import { importTestBundle } from "#test-bundle";
import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { createDeferred, createManualScheduler } from "#test-timing";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";

const root = path.resolve(import.meta.dirname, "..", "..");
let modulePromise;

async function loadModelRuntimeModule() {
  if (modulePromise) return modulePromise;
  modulePromise = (async () => {
    return importTestBundle("src/agent-host/model-runtime", {
      packages: "external",
      absWorkingDir: root,
      entryPoints: ["src/agent-host/model-runtime.ts"],
    });
  })();
  return modulePromise;
}

function abortableResult(signal, result = { aborted: false, errors: new Map() }) {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve({ aborted: true, errors: new Map() });
    signal.addEventListener("abort", () => resolve({ aborted: true, errors: new Map() }), { once: true });
    if (!result.aborted) setImmediate(() => resolve(result));
  });
}

test("offline catalog refresh creates cache services without requesting network", async () => {
  const { ModelCatalogRefreshCoordinator } = await loadModelRuntimeModule();
  const coordinator = new ModelCatalogRefreshCoordinator(100, () => true);
  let calls = 0;
  const result = await coordinator.refresh("/project", "offline", async () => ({
    modelRuntime: {
      async refresh() {
        calls += 1;
        return { aborted: false, errors: new Map() };
      },
    },
  }));
  assert.equal(calls, 0);
  assert.deepEqual(result.catalog, { source: "offline", refreshed: false, aborted: false, warnings: [] });
});

test("cancelled refresh responses do not end ownership of the underlying work", async () => {
  const { ModelCatalogRefreshCoordinator } = await loadModelRuntimeModule();
  const coordinator = new ModelCatalogRefreshCoordinator(10000, () => false),
    started = createDeferred(),
    release = createDeferred();
  const request = coordinator.refresh("/project", "pending", async () => ({
    modelRuntime: {
      refresh: async () => {
        started.resolve();
        await release.promise;
        return { aborted: true, errors: new Map() };
      },
    },
  }));
  await started.promise;
  coordinator.cancelAll();
  assert.equal((await request).catalog.aborted, true);
  let complete = false;
  const settled = coordinator.settled().then(() => {
    complete = true;
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(complete, false);
  release.resolve();
  await settled;
  assert.equal(complete, true);
});

test("provider failures are stable warnings while successful catalogs remain refreshed", async () => {
  const { ModelCatalogRefreshCoordinator } = await loadModelRuntimeModule();
  const coordinator = new ModelCatalogRefreshCoordinator(100, () => false);
  const result = await coordinator.refresh("/project", "partial", async () => ({
    modelRuntime: {
      async refresh(options) {
        assert.equal(options.allowNetwork, true);
        assert.equal(options.force, true);
        return { aborted: false, errors: new Map([["pi.dev", new Error("secret upstream detail")]]) };
      },
    },
  }));
  assert.equal(result.catalog.refreshed, true);
  assert.equal(result.catalog.aborted, false);
  assert.deepEqual(result.catalog.warnings, [
    {
      provider: "pi.dev",
      code: "PROVIDER_REFRESH_FAILED",
      message: "Unable to refresh the pi.dev model catalog; cached models remain available.",
    },
  ]);
  assert.equal(JSON.stringify(result.catalog).includes("secret upstream detail"), false);
});

test("catalog refresh times out and reports an aborted cache-preserving result", async () => {
  const { ModelCatalogRefreshCoordinator } = await loadModelRuntimeModule();
  const scheduler = createManualScheduler();
  const refreshStarted = createDeferred();
  const coordinator = new ModelCatalogRefreshCoordinator(5, () => false, scheduler);
  const pending = coordinator.refresh("/project", "timeout", async () => ({
    modelRuntime: {
      refresh(options) {
        refreshStarted.resolve();
        return abortableResult(options.signal, { aborted: true, errors: new Map() });
      },
    },
  }));
  await refreshStarted.promise;
  await scheduler.runNext();
  const result = await pending;
  assert.equal(result.catalog.aborted, true);
  assert.equal(result.catalog.refreshed, false);
  assert.equal(result.catalog.warnings[0].code, "MODEL_REFRESH_TIMEOUT");
});

test("the Desktop 12s budget aborts the real OpenRouter refresh before its 15s deadline and retains the catalog", async (t) => {
  const { ModelCatalogRefreshCoordinator, MODEL_CATALOG_REFRESH_TIMEOUT_MS } = await loadModelRuntimeModule();
  assert.equal(MODEL_CATALOG_REFRESH_TIMEOUT_MS, 12000);
  const previousOffline = process.env.PI_OFFLINE;
  delete process.env.PI_OFFLINE;
  t.after(() => {
    if (previousOffline === undefined) delete process.env.PI_OFFLINE;
    else process.env.PI_OFFLINE = previousOffline;
  });
  const runtime = await ModelRuntime.create({
    modelsPath: null,
    refreshOnCreate: false,
    catalogBaseUrl: "https://catalog.fixture.invalid",
    credentials: {
      read: async () => undefined,
      list: async () => [],
      modify: async () => {
        throw new Error("read only");
      },
      delete: async () => {},
    },
  });
  await runtime.setRuntimeApiKey("openrouter", "SYNTHETIC_KEY");
  const id = runtime.getModels().find((model) => model.provider === "openrouter").id;
  const entered = createDeferred();
  let hold = false,
    requestSignal;
  t.mock.method(globalThis, "fetch", async (input, options) => {
    if (String(input).startsWith("https://catalog.fixture.invalid/"))
      return new globalThis.Response(null, { status: 404 });
    assert.equal(String(input), "https://openrouter.ai/api/v1/models/user");
    if (!hold) return globalThis.Response.json({ data: [{ id, context_length: 4096 }] });
    requestSignal = options.signal;
    entered.resolve();
    return new Promise((_, reject) =>
      options.signal.addEventListener("abort", () => reject(options.signal.reason), { once: true }),
    );
  });
  await runtime.refresh({ allowNetwork: true, force: true, providers: ["openrouter"] });
  const catalog = () =>
    runtime
      .getModels()
      .filter((model) => model.provider === "openrouter")
      .map((model) => ({ id: model.id, contextWindow: model.contextWindow }));
  const before = catalog();
  assert.deepEqual(before, [{ id, contextWindow: 4096 }]);
  const scheduler = createManualScheduler();
  let upstreamExpired = false,
    timeoutCalls = 0;
  const nativeTimeout = globalThis.AbortSignal.timeout;
  t.mock.method(globalThis.AbortSignal, "timeout", (ms) => {
    if (ms !== 15000) return nativeTimeout(ms);
    timeoutCalls++;
    const controller = new globalThis.AbortController();
    scheduler.setTimeout(() => {
      upstreamExpired = true;
      controller.abort();
    }, ms);
    return controller.signal;
  });
  hold = true;
  const coordinator = new ModelCatalogRefreshCoordinator(undefined, () => false, scheduler);
  const pending = coordinator.refresh("fixture", "request", async () => ({
    modelRuntime: { refresh: (options) => runtime.refresh({ ...options, providers: ["openrouter"] }) },
  }));
  await entered.promise;
  assert.equal(timeoutCalls, 1);
  assert.equal(requestSignal.aborted, false);
  await scheduler.runNext();
  const result = await pending;
  assert.equal(result.catalog.aborted, true);
  assert.equal(result.catalog.warnings[0].code, "MODEL_REFRESH_TIMEOUT");
  assert.equal(upstreamExpired, false);
  assert.equal(requestSignal.aborted, true);
  await coordinator.settled();
  assert.deepEqual(catalog(), before);
  await scheduler.runNext();
  assert.equal(upstreamExpired, true);
  assert.deepEqual(catalog(), before);
});

test("the timeout bounds service creation even when an extension ignores cancellation", async () => {
  const { ModelCatalogRefreshAbortedError, ModelCatalogRefreshCoordinator } = await loadModelRuntimeModule();
  const scheduler = createManualScheduler();
  const coordinator = new ModelCatalogRefreshCoordinator(5, () => false, scheduler);
  const pending = coordinator.refresh("/project", "hung-services", async () => new Promise(() => {}));
  const rejected = assert.rejects(
    pending,
    (error) => error instanceof ModelCatalogRefreshAbortedError && error.kind === "timeout",
  );
  await scheduler.runNext();
  await rejected;
});

test("the timeout also bounds final model-list projection", async () => {
  const { ModelCatalogRefreshCoordinator } = await loadModelRuntimeModule();
  const scheduler = createManualScheduler();
  const projectionStarted = createDeferred();
  const coordinator = new ModelCatalogRefreshCoordinator(5, () => false, scheduler);
  const pending = coordinator.refresh(
    "/project",
    "hung-projection",
    async () => ({
      modelRuntime: {
        async refresh() {
          return { aborted: false, errors: new Map() };
        },
      },
    }),
    ({ catalog }) => {
      if (catalog.aborted) return { catalog, source: "cached-snapshot" };
      projectionStarted.resolve();
      return new Promise(() => {});
    },
  );
  await projectionStarted.promise;
  await scheduler.runNext();
  const result = await pending;

  assert.equal(result.source, "cached-snapshot");
  assert.equal(result.catalog.aborted, true);
  assert.equal(result.catalog.warnings[0].code, "MODEL_REFRESH_TIMEOUT");
});

test("a replacement refresh cancels the older cwd generation", async () => {
  const { ModelCatalogRefreshCoordinator } = await loadModelRuntimeModule();
  const coordinator = new ModelCatalogRefreshCoordinator(500, () => false);
  let firstSignal;
  const first = coordinator.refresh("/project", "first", async () => ({
    modelRuntime: {
      refresh(options) {
        firstSignal = options.signal;
        return abortableResult(options.signal, { aborted: true, errors: new Map() });
      },
    },
  }));
  await new Promise((resolve) => setImmediate(resolve));
  const second = coordinator.refresh("/project", "second", async () => ({
    modelRuntime: {
      async refresh() {
        return { aborted: false, errors: new Map() };
      },
    },
  }));
  assert.equal(firstSignal.aborted, true);
  assert.equal((await first).catalog.aborted, true);
  assert.equal((await second).catalog.refreshed, true);
});

test("explicit cancellation aborts the matching request only once", async () => {
  const { ModelCatalogRefreshCoordinator } = await loadModelRuntimeModule();
  const coordinator = new ModelCatalogRefreshCoordinator(500, () => false);
  const pending = coordinator.refresh("/project", "cancel-me", async () => ({
    modelRuntime: {
      refresh(options) {
        return abortableResult(options.signal, { aborted: true, errors: new Map() });
      },
    },
  }));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(coordinator.cancel("cancel-me"), true);
  assert.equal((await pending).catalog.aborted, true);
  assert.equal(coordinator.cancel("cancel-me"), false);
});
