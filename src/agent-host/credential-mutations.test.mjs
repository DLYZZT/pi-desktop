import { importTestBundle } from "#test-bundle";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";
import { createDeferred } from "#test-timing";

const root = path.resolve(import.meta.dirname, "..", "..");
const { CredentialMutations } = await importTestBundle("credential-mutations", {
  packages: "external",
  absWorkingDir: root,
  entryPoints: ["src/agent-host/credential-mutations.ts"],
});
// Compatibility probe only: production uses public SDK/native-auth APIs.
const sdkEntry = fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"));
const { FileAuthStorageBackend } = await import(
  pathToFileURL(path.join(path.dirname(sdkEntry), "core/auth-storage.js"))
);

function fixture(t, credential) {
  const dir = mkdtempSync(path.join(tmpdir(), "pi-credential-cas-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const filename = path.join(dir, "auth.json");
  writeFileSync(filename, JSON.stringify({ openai: credential, other: { type: "api_key", key: "other-fixture" } }));
  return { filename, mutations: new CredentialMutations(filename) };
}

test("conditional delete checks type and version under the actual SDK file lock", async (t) => {
  const f = fixture(t, { type: "api_key", key: "original-fixture" });
  const before = await f.mutations.snapshot("openai");
  const locked = createDeferred(),
    finishWrite = createDeferred();
  const writer = new FileAuthStorageBackend(f.filename);
  const cliWriting = writer.withLockAsync(async (content) => {
    locked.resolve();
    await finishWrite.promise;
    const data = JSON.parse(content);
    data.openai = {
      type: "oauth",
      access: "fixture-access",
      refresh: "fixture-refresh",
      expires: Date.now() + 3600000,
    };
    return { result: undefined, next: JSON.stringify(data) };
  });
  await locked.promise;
  let refreshed = false;
  const deletion = f.mutations.logout(
    {
      async refresh() {
        refreshed = true;
        return { aborted: false, errors: new Map() };
      },
    },
    "openai",
    "api_key",
    before.version,
  );
  const rejection = assert.rejects(deletion, (error) => error.code === "CONFLICT");
  finishWrite.resolve();
  await cliWriting;
  await rejection;
  assert.equal(refreshed, false);
  assert.equal(JSON.parse(readFileSync(f.filename)).openai.type, "oauth");
  await assert.rejects(f.mutations.logout({}, "openai", "api_key"), (error) => error.code === "CONFLICT");
});

test("same-type replacement during login invalidates the confirmed version and preserves all providers", async (t) => {
  const f = fixture(t, { type: "api_key", key: "original-fixture" });
  const before = await f.mutations.snapshot("openai");
  const runtime = {
    getProvider: () => ({
      auth: {
        apiKey: {
          async login() {
            const writer = new FileAuthStorageBackend(f.filename);
            await writer.withLockAsync(async (content) => {
              const data = JSON.parse(content);
              data.openai = { type: "api_key", key: "concurrent-fixture" };
              return { result: undefined, next: JSON.stringify(data) };
            });
            return { type: "api_key", key: "requested-fixture" };
          },
        },
      },
    }),
    async refresh() {
      assert.fail("Uncommitted login must not synchronize");
    },
  };
  await assert.rejects(
    f.mutations.login(
      runtime,
      "openai",
      "api_key",
      {
        async prompt() {
          return "fixture";
        },
        notify() {},
      },
      undefined,
      { expectedVersion: before.version },
    ),
    (error) => error.code === "CONFLICT",
  );
  const data = JSON.parse(readFileSync(f.filename));
  assert.equal(data.openai.key, "concurrent-fixture");
  assert.equal(data.other.key, "other-fixture");
});

test("authentication replacement requires confirmation and cancellation prevents a late commit", async (t) => {
  const f = fixture(t, {
    type: "oauth",
    access: "fixture-access",
    refresh: "fixture-refresh",
    expires: Date.now() + 3600000,
  });
  const before = readFileSync(f.filename, "utf8");
  const confirmed = await f.mutations.snapshot("openai");
  const controller = new globalThis.AbortController();
  let logins = 0;
  const runtime = {
    getProvider: () => ({
      auth: {
        apiKey: {
          async login() {
            logins++;
            controller.abort();
            return { type: "api_key", key: "cancelled-fixture" };
          },
        },
      },
    }),
  };
  const interaction = {
    signal: controller.signal,
    async prompt() {
      return "fixture";
    },
    notify() {},
  };
  await assert.rejects(
    f.mutations.login(runtime, "openai", "api_key", interaction),
    (error) => error.code === "CONFLICT",
  );
  assert.equal(logins, 0);
  await assert.rejects(
    f.mutations.login(runtime, "openai", "api_key", interaction, undefined, {
      replaceExisting: true,
      expectedVersion: confirmed.version,
    }),
    (error) => error.name === "AbortError",
  );
  assert.equal(readFileSync(f.filename, "utf8"), before);
});
