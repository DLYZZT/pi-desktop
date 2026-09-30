import { importTestBundle } from "#test-bundle";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createDeferred } from "#test-timing";

const root = path.resolve(import.meta.dirname, "..", "..");
const agentDir = mkdtempSync(path.join(tmpdir(), "pi-auth-provider-integration-"));
process.env.PI_CODING_AGENT_DIR = agentDir;
process.env.PI_OFFLINE = "1";
test.after(() => rmSync(agentDir, { recursive: true, force: true }));
const { createAuthHandlers, createAuthLoginService, getSharedModelRuntime, getCredentialMutations } =
  await importTestBundle("auth-provider-integration", {
    packages: "external",
    absWorkingDir: root,
    stdin: {
      contents:
        'export {createAuthHandlers} from "./handlers/auth.ts"; export {createAuthLoginService} from "./auth-login.ts"; export {getSharedModelRuntime} from "./model-runtime.ts"; export {getCredentialMutations} from "./credential-mutations.ts";',
      resolveDir: import.meta.dirname,
      loader: "ts",
    },
  });

test("desktop auth commits OpenAI subscription login with device ID and never deletes OAuth as an API key", async (t) => {
  const runtime = await getSharedModelRuntime();
  const original = runtime.getProvider("openai");
  const events = [],
    waiters = new Map();
  const service = createAuthLoginService({
    emit(_topic, _key, event) {
      events.push(event);
      waiters.get(event.type)?.resolve(event);
    },
  });
  t.after(() => {
    service.dispose();
    runtime.registerNativeProvider(original);
  });
  const handlers = createAuthHandlers(service);
  await handlers.setApiKey({ provider: "openai", key: "sk-integration-fixture" });
  const before = await getCredentialMutations().snapshot("openai");
  let logins = 0,
    loginDeviceId;
  runtime.registerNativeProvider({
    ...original,
    auth: {
      ...original.auth,
      oauth: {
        ...original.auth.oauth,
        async login(interaction, options) {
          logins++;
          loginDeviceId = options.getDeviceId();
          interaction.notify({ type: "auth_url", url: "https://auth.example.test/authorize" });
          const answer = await interaction.prompt({
            type: "manual_code",
            message: "Fixture callback",
            signal: interaction.signal,
          });
          assert.equal(answer, "approved");
          return {
            type: "oauth",
            access: "integration-access",
            refresh: "integration-refresh",
            clientId: "fixture-client",
            expires: Date.now() + 3600000,
          };
        },
      },
    },
  });

  const failed = createDeferred();
  waiters.set("error", failed);
  await handlers.startLogin({ provider: "openai", expectedVersion: before.version });
  assert.match((await failed.promise).message, /replacement confirmation/);
  assert.equal(logins, 0);
  assert.equal((await getCredentialMutations().snapshot("openai")).type, "api_key");

  const auth = createDeferred(),
    success = createDeferred();
  waiters.set("auth", auth);
  waiters.set("success", success);
  await handlers.startLogin({ provider: "openai", expectedVersion: before.version, replaceExisting: true });
  const challenge = await auth.promise;
  assert.equal(loginDeviceId, JSON.parse(readFileSync(path.join(agentDir, "settings.json"))).deviceId);
  await handlers.submitLogin({ provider: "openai", token: challenge.token, code: "approved" });
  await success.promise;
  assert.equal(events.filter((event) => event.type === "success").length, 1);
  const oauth = await getCredentialMutations().snapshot("openai");
  assert.equal(oauth.type, "oauth");
  const apiStatus = (await handlers.allProviders()).providers.find((provider) => provider.id === "openai");
  assert.equal(apiStatus.configured, false);
  assert.equal(apiStatus.storedAuthType, "oauth");
  assert.equal((await handlers.providers()).providers.find((provider) => provider.id === "openai").loggedIn, true);
  await assert.rejects(
    handlers.deleteApiKey({ provider: "openai", expectedVersion: oauth.version }),
    (error) => error.code === "CONFLICT",
  );
  assert.equal((await getCredentialMutations().snapshot("openai")).type, "oauth");
  await assert.rejects(
    handlers.setApiKey({ provider: "openai", key: "sk-replacement-fixture" }),
    (error) => error.code === "CONFLICT",
  );
  await handlers.setApiKey({
    provider: "openai",
    key: "sk-replacement-fixture",
    expectedVersion: oauth.version,
    replaceExisting: true,
  });
  const key = await getCredentialMutations().snapshot("openai");
  await assert.rejects(
    handlers.logout({ provider: "openai", expectedVersion: key.version }),
    (error) => error.code === "CONFLICT",
  );
  await handlers.deleteApiKey({ provider: "openai", expectedVersion: key.version });
  assert.equal((await getCredentialMutations().snapshot("openai")).type, null);
});

test("ChatGPT login rejects a custom OpenAI gateway before opening authorization", async () => {
  const runtime = await getSharedModelRuntime(),
    original = runtime.getProvider("openai");
  runtime.registerProvider("openai", { baseUrl: "https://gateway.example.test/v1" });
  const terminal = createDeferred();
  let opened = false;
  const service = createAuthLoginService({
    emit(_topic, _key, event) {
      if (event.type === "auth") opened = true;
      if (event.type === "error") terminal.resolve(event);
    },
  });
  try {
    await service.start("openai");
    assert.match((await terminal.promise).message, /default OpenAI endpoint/);
    assert.equal(opened, false);
  } finally {
    service.dispose();
    runtime.unregisterProvider("openai");
    runtime.registerNativeProvider(original);
  }
});

for (const outcome of ["cancel", "error-callback"]) {
  test(`real OpenAI OAuth emits an auth URL with the persisted installation ID and settles once (${outcome})`, async () => {
    const auth = createDeferred(),
      terminal = createDeferred(),
      events = [];
    const service = createAuthLoginService({
      emit(_topic, _key, event) {
        events.push(event);
        if (event.type === "auth") auth.resolve(event);
        if (["cancelled", "error", "success"].includes(event.type)) terminal.resolve(event);
      },
    });
    try {
      await service.start("openai");
      const challenge = await auth.promise;
      const url = new URL(challenge.url);
      const id = JSON.parse(readFileSync(path.join(agentDir, "settings.json"))).deviceId;
      assert.equal(url.searchParams.get("ext_agent_host_id"), `urn:uuid:${id}`);
      if (outcome === "cancel") service.cancel("openai");
      else {
        const callback = new URL(url.searchParams.get("redirect_uri"));
        callback.searchParams.set("state", url.searchParams.get("state"));
        callback.searchParams.set("error", "access_denied");
        await createAuthHandlers(service).submitLogin({
          provider: "openai",
          token: challenge.token,
          code: callback.toString(),
        });
      }
      const result = await terminal.promise;
      assert.equal(result.type, outcome === "cancel" ? "cancelled" : "error");
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(events.filter((event) => ["cancelled", "error", "success"].includes(event.type)).length, 1);
      assert.equal((await getCredentialMutations().snapshot("openai")).type, null);
    } finally {
      service.dispose();
    }
  });
}
