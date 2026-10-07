import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { readStoredCredential, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { createDeferred } from "#test-timing";
import { importTestBundle } from "#test-bundle";
const { DesktopModelCredentials } = await importTestBundle("model-credentials", {
  packages: "external",
  entryPoints: [path.join(import.meta.dirname, "model-credentials.ts")],
});
// Exercise the installed SDK's cancellation/refresh path; production uses only the public CredentialStore API.
const { resolveProviderAuth } = await import(
  new URL("./auth/resolve.js", import.meta.resolve("@earendil-works/pi-ai"))
);
function fixture(t) {
  const root = mkdtempSync(path.join(tmpdir(), "pi-model-credential-life-")),
    filename = path.join(root, "auth.json");
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(
    filename,
    JSON.stringify({
      fixture: { type: "oauth", access: "OLD", refresh: "OLD_REFRESH", expires: 0, future: 42 },
      other: { type: "api_key", key: "OTHER" },
    }),
  );
  return { filename, store: new DesktopModelCredentials(filename) };
}
test("cancelled SDK auth returns promptly while shutdown waits for the rotated token to be saved under the CLI lock", async (t) => {
  const f = fixture(t),
    started = createDeferred(),
    release = createDeferred(),
    controller = new globalThis.AbortController();
  let providerSignal;
  const provider = {
    id: "fixture",
    auth: {
      oauth: {
        refresh: async (value, signal) => {
          providerSignal = signal;
          started.resolve();
          await release.promise;
          return { ...value, access: "NEW", refresh: "ROTATED", expires: Date.now() + 3600000 };
        },
        toAuth: (credential) => ({ apiKey: credential.access }),
      },
    },
  };
  const auth = resolveProviderAuth(
    provider,
    f.store,
    { env: async () => undefined, fileExists: async () => false },
    { signal: controller.signal },
  );
  await started.promise;
  controller.abort(new Error("cancel fixture"));
  await assert.rejects(auth, /cancel fixture/);
  f.store.stopWaiting();
  let finished = false;
  const stopping = f.store.settled().then(() => {
    finished = true;
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(finished, false);
  assert.equal(providerSignal.aborted, false);
  await assert.rejects(
    f.store.modify("another", async () => ({ type: "api_key", key: "must not save" })),
    /shutting down/,
  );
  release.resolve();
  await stopping;
  assert.equal(readStoredCredential("fixture", f.filename).refresh, "ROTATED");
  assert.equal(readStoredCredential("fixture", f.filename).future, 42);
  assert.equal(readStoredCredential("other", f.filename).key, "OTHER");
  if (process.platform !== "win32") assert.equal(statSync(f.filename).mode & 0o777, 0o600);
});
test("shutdown cancels queued credential mutations but lets the active owner commit", async (t) => {
  const f = fixture(t),
    entered = createDeferred(),
    release = createDeferred();
  let laterCalled = false;
  const first = f.store.modify("fixture", async (value) => {
    entered.resolve();
    await release.promise;
    return { ...value, access: "COMMITTED" };
  });
  await entered.promise;
  const second = f.store.modify("other", async (value) => {
    laterCalled = true;
    return value;
  });
  f.store.stopWaiting();
  const rejected = assert.rejects(second, /shutting down/);
  release.resolve();
  await Promise.all([first, rejected, f.store.settled()]);
  assert.equal(laterCalled, false);
  assert.equal(JSON.parse(readFileSync(f.filename)).fixture.access, "COMMITTED");
});
test("logout serializes after refresh and unrelated stored fields survive", async (t) => {
  const f = fixture(t),
    entered = createDeferred(),
    release = createDeferred();
  const refresh = f.store.modify("fixture", async (value) => {
    entered.resolve();
    await release.promise;
    return { ...value, access: "FRESH" };
  });
  await entered.promise;
  const logout = f.store.delete("fixture");
  release.resolve();
  await Promise.all([refresh, logout]);
  assert.equal(readStoredCredential("fixture", f.filename), undefined);
  assert.equal(readStoredCredential("other", f.filename).key, "OTHER");
});
test("the public ModelRuntime credential-store injection resolves API keys and notices external CLI edits", async (t) => {
  const f = fixture(t);
  writeFileSync(f.filename, JSON.stringify({ anthropic: { type: "api_key", key: "FIRST" } }));
  const runtime = await ModelRuntime.create({ credentials: f.store, modelsPath: null, refreshOnCreate: false });
  assert.equal((await runtime.getAuth("anthropic")).auth.apiKey, "FIRST");
  writeFileSync(f.filename, JSON.stringify({ anthropic: { type: "api_key", key: "SECOND" } }));
  assert.equal((await runtime.getAuth("anthropic")).auth.apiKey, "SECOND");
});
