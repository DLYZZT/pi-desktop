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
  const authStorage = {
    getOAuthProviders() {
      return [{ id: "test-oauth" }];
    },
    async login(_provider, callbacks) {
      await callbacks.onSelect({
        message: "Choose a login method",
        options: [{ id: "browser", label: "Browser" }],
      });
    },
  };
  const service = createAuthLoginService(server, () => authStorage);

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
