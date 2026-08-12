import { importTestBundle } from "#test-bundle";
import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { CredentialSynchronizationError } from "@earendil-works/pi-coding-agent";

const root = path.resolve(import.meta.dirname, "..", "..");
let modulePromise;

async function loadAuthLoginModule() {
  if (modulePromise) return modulePromise;
  modulePromise = (async () => {
    return importTestBundle("src/agent-host/auth-login", {
      packages: "external",
      absWorkingDir: root,
      entryPoints: ["src/agent-host/auth-login.ts"],
    });
  })();
  return modulePromise;
}

function nextTurn() {
  return new Promise((resolve) => setImmediate(resolve));
}

test("a cancelled OAuth flow cannot clear the active replacement flow", async () => {
  const { createAuthLoginService } = await loadAuthLoginModule();
  const events = [];
  const server = {
    emit(topic, key, data) {
      events.push({ topic, key, data });
    },
  };
  const modelRuntime = {
    getProvider(provider) {
      return provider === "test-oauth" ? { auth: { oauth: {} } } : undefined;
    },
    async login(_provider, type, interaction) {
      assert.equal(type, "oauth");
      await interaction.prompt({
        type: "select",
        message: "Choose a login method",
        options: [{ id: "browser", label: "Browser" }],
      });
    },
  };
  const service = createAuthLoginService(server, () => modelRuntime);

  assert.deepEqual(await service.start("test-oauth"), { started: true });
  service.cancel("test-oauth");
  assert.deepEqual(await service.start("test-oauth"), { started: true });

  // Let the cancelled flow reach its catch/finally after the replacement starts.
  await nextTurn();
  assert.deepEqual(await service.start("test-oauth"), { started: false });
  assert.equal(
    events.some((event) => event.data.type === "cancelled"),
    true,
  );

  service.cancel("test-oauth");
  await nextTurn();
});

test("ModelRuntime auth notifications and prompts map onto the desktop login stream", async () => {
  const { createAuthLoginService, resolveLoginCode } = await loadAuthLoginModule();
  const events = [];
  const server = {
    emit(topic, key, data) {
      events.push({ topic, key, data });
    },
  };
  const modelRuntime = {
    getProvider() {
      return { auth: { oauth: {} } };
    },
    async login(_provider, type, interaction) {
      assert.equal(type, "oauth");
      interaction.notify({ type: "auth_url", url: "https://example.test/login", instructions: "Sign in" });
      interaction.notify({
        type: "device_code",
        userCode: "ABCD-EFGH",
        verificationUri: "https://example.test/device",
        intervalSeconds: 5,
      });
      interaction.notify({ type: "progress", message: "Waiting for authorization" });
      const code = await interaction.prompt({ type: "manual_code", message: "Paste the authorization code" });
      assert.equal(code, "approved");
    },
  };
  const service = createAuthLoginService(server, () => modelRuntime);

  assert.deepEqual(await service.start("test-oauth"), { started: true });
  const promptEvent = events.find((event) => event.data.type === "prompt_request");
  assert.ok(promptEvent?.data.token);
  assert.equal(resolveLoginCode("test-oauth", promptEvent.data.token, "approved"), true);
  await nextTurn();

  assert.deepEqual(
    events.map((event) => event.data.type),
    ["auth", "device_code", "progress", "prompt_request", "success"],
  );
  assert.equal(events[0].data.token, promptEvent.data.token);
});

test("pending login tokens are cancelled and resolved by exact provider ownership", async () => {
  const { createAuthLoginService, resolveLoginCode } = await loadAuthLoginModule();
  const events = [];
  const service = createAuthLoginService(
    {
      emit(_topic, key, data) {
        events.push({ provider: key, ...data });
      },
    },
    () => ({
      getProvider() {
        return { auth: { oauth: {} } };
      },
      async login(provider, _type, interaction) {
        const code = await interaction.prompt({ type: "manual_code", message: `Code for ${provider}` });
        assert.equal(code, `${provider}-approved`);
      },
    }),
  );

  await service.start("openai");
  await service.start("openai-codex-test");
  const openaiToken = events.find((event) => event.provider === "openai" && event.type === "prompt_request").token;
  const codexToken = events.find(
    (event) => event.provider === "openai-codex-test" && event.type === "prompt_request",
  ).token;

  assert.equal(resolveLoginCode("openai", codexToken, "wrong-owner"), false);
  service.cancel("openai");
  assert.equal(resolveLoginCode("openai", openaiToken, "too-late"), false);
  assert.equal(resolveLoginCode("openai-codex-test", codexToken, "openai-codex-test-approved"), true);
  await nextTurn();

  assert.equal(
    events.some((event) => event.provider === "openai" && event.type === "cancelled"),
    true,
  );
  assert.equal(
    events.some((event) => event.provider === "openai-codex-test" && event.type === "success"),
    true,
  );
});

test("OAuth credential synchronization failure emits success with a safe warning after read-back", async () => {
  const { createAuthLoginService } = await loadAuthLoginModule();
  const events = [];
  const service = createAuthLoginService(
    {
      emit(topic, key, data) {
        events.push({ topic, key, data });
      },
    },
    () => ({
      getProvider() {
        return { auth: { oauth: {} } };
      },
      async login() {
        throw new CredentialSynchronizationError(
          "test-oauth",
          "login",
          { type: "oauth", access: "secret", refresh: "secret", expires: Date.now() + 60_000 },
          { cause: new Error("secret synchronization detail") },
        );
      },
      async listCredentials() {
        return [{ providerId: "test-oauth", type: "oauth" }];
      },
      async refresh() {
        return { aborted: false, errors: new Map([["test-oauth", new Error("secret refresh detail")]]) };
      },
    }),
  );

  assert.deepEqual(await service.start("test-oauth"), { started: true });
  await nextTurn();
  const terminal = events.find((event) => event.data.type === "success");
  assert.equal(terminal.data.warning.code, "MODEL_SYNC_FAILED");
  assert.equal(JSON.stringify(terminal).includes("secret"), false);
  assert.equal(
    events.some((event) => event.data.type === "error"),
    false,
  );
});
