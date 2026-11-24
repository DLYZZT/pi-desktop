import assert from "node:assert/strict";
import { lstatSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
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
const { AuthStorage } = await import(
  new URL("./core/auth-storage.js", import.meta.resolve("@earendil-works/pi-coding-agent"))
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

function linkCredentialFile(t, filename, target) {
  try {
    symlinkSync(target, filename, "file");
    return true;
  } catch (error) {
    if (process.platform !== "win32" || !["EPERM", "EACCES"].includes(error.code)) throw error;
    t.skip("File symlinks are unavailable on this Windows host");
    return false;
  }
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

test("Desktop and the Pi CLI serialize writes through an auth.json symlink and preserve the link", async (t) => {
  const { filename } = fixture(t);
  const alias = path.join(path.dirname(filename), "alias.json");
  if (!linkCredentialFile(t, alias, path.basename(filename))) return;
  const desktop = new DesktopModelCredentials(alias);
  const entered = createDeferred();
  const release = createDeferred();
  const cli = AuthStorage.create(alias).modify("fixture", async (current) => {
    entered.resolve();
    await release.promise;
    return { ...current, access: "CLI_ROTATION" };
  });
  try {
    await Promise.race([entered.promise, cli]);
    const timeout = globalThis.AbortSignal.timeout(60);
    await assert.rejects(
      desktop.modify("other", async () => assert.fail("Desktop entered while the CLI held the lock"), {
        signal: timeout,
      }),
      (error) => error === timeout.reason || error.cause === timeout.reason,
    );
  } finally {
    release.resolve();
    await cli;
  }
  assert.equal((await desktop.read("fixture")).access, "CLI_ROTATION");
  await desktop.modify("fixture", async (current) => ({ ...current, access: "DESKTOP_ROTATION" }));
  await desktop.delete("other");
  assert.equal(lstatSync(alias).isSymbolicLink(), true);
  assert.equal(readStoredCredential("fixture", filename).access, "DESKTOP_ROTATION");
  assert.equal(readStoredCredential("other", filename), undefined);
});

test("saving the first credential follows a dangling auth.json symlink", async (t) => {
  const { filename } = fixture(t);
  const dir = path.dirname(filename);
  const alias = path.join(dir, "missing-alias.json");
  const target = path.join(dir, "new-auth.json");
  if (!linkCredentialFile(t, alias, path.basename(target))) return;
  const desktop = new DesktopModelCredentials(alias);
  assert.equal(await desktop.read("fixture"), undefined);
  await desktop.modify("fixture", async () => ({ type: "api_key", key: "INITIAL" }));
  assert.equal(lstatSync(alias).isSymbolicLink(), true);
  assert.equal(readStoredCredential("fixture", target).key, "INITIAL");
});
