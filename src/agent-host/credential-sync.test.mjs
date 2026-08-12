import { importTestBundle } from "#test-bundle";
import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

const root = path.resolve(import.meta.dirname, "..", "..");
let modulePromise;

async function loadCredentialSyncModule() {
  if (modulePromise) return modulePromise;
  modulePromise = (async () => {
    return importTestBundle("src/agent-host/credential-sync", {
      packages: "external",
      absWorkingDir: root,
      entryPoints: ["src/agent-host/credential-sync.ts"],
    });
  })();
  return modulePromise;
}

test("credential state matching respects provider, type, and desired presence", async () => {
  const { credentialStateMatches } = await loadCredentialSyncModule();
  const runtime = {
    async listCredentials() {
      return [
        { providerId: "openai", type: "api_key" },
        { providerId: "openai-codex", type: "oauth" },
      ];
    },
  };
  assert.equal(await credentialStateMatches(runtime, "openai", { present: true, type: "api_key" }), true);
  assert.equal(await credentialStateMatches(runtime, "openai", { present: true, type: "oauth" }), false);
  assert.equal(await credentialStateMatches(runtime, "openai", { present: false, type: "oauth" }), true);
});

test("a committed credential with a successful cache refresh is fully synchronized", async () => {
  const { recoverCommittedCredential } = await loadCredentialSyncModule();
  const runtime = {
    async listCredentials() {
      return [{ providerId: "openai", type: "api_key" }];
    },
    async refresh(options) {
      assert.deepEqual(options, { allowNetwork: false, providers: ["openai"] });
      return { aborted: false, errors: new Map() };
    },
  };
  assert.deepEqual(await recoverCommittedCredential(runtime, "openai", { present: true, type: "api_key" }), {
    ok: true,
    synchronized: true,
  });
});

test("a committed credential with a failed cache refresh returns a safe warning", async () => {
  const { recoverCommittedCredential } = await loadCredentialSyncModule();
  const runtime = {
    async listCredentials() {
      return [{ providerId: "openai", type: "api_key" }];
    },
    async refresh() {
      return { aborted: false, errors: new Map([["openai", new Error("secret provider detail")]]) };
    },
  };
  const result = await recoverCommittedCredential(runtime, "openai", { present: true, type: "api_key" });
  assert.equal(result.ok, true);
  assert.equal(result.synchronized, false);
  assert.equal(result.warning.code, "MODEL_SYNC_FAILED");
  assert.equal(JSON.stringify(result).includes("secret provider detail"), false);
});

test("a synchronization error cannot be called success when read-back misses the target state", async () => {
  const { recoverCommittedCredential } = await loadCredentialSyncModule();
  const runtime = {
    async listCredentials() {
      return [];
    },
    async refresh() {
      throw new Error("must not refresh an unverified credential");
    },
  };
  assert.equal(await recoverCommittedCredential(runtime, "openai", { present: true, type: "api_key" }), null);
});
