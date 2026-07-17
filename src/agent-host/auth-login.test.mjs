import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = path.resolve(import.meta.dirname, "..", "..");
let modulePromise;

async function loadAuthLoginModule() {
  if (modulePromise) return modulePromise;
  modulePromise = (async () => {
    const outputDirectory = path.join(root, ".artifacts", "test-modules");
    mkdirSync(outputDirectory, { recursive: true });
    const outputFile = path.join(outputDirectory, `auth-login-${process.pid}.mjs`);
    await build({
      absWorkingDir: root,
      entryPoints: ["src/agent-host/auth-login.ts"],
      outfile: outputFile,
      bundle: true,
      format: "esm",
      platform: "node",
      packages: "external",
      sourcemap: false,
      logLevel: "silent",
    });
    return import(`${pathToFileURL(outputFile).href}?v=${Date.now()}`);
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
  assert.equal(resolveLoginCode(promptEvent.data.token, "approved"), true);
  await nextTurn();

  assert.deepEqual(
    events.map((event) => event.data.type),
    ["auth", "device_code", "progress", "prompt_request", "success"],
  );
  assert.equal(events[0].data.token, promptEvent.data.token);
});
