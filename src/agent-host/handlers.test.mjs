import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = path.resolve(import.meta.dirname, "..", "..");
const isolatedAgentDirectory = mkdtempSync(path.join(tmpdir(), "pi-handler-agent-"));
process.env.PI_CODING_AGENT_DIR = isolatedAgentDirectory;
process.env.PI_CODING_AGENT_SESSION_DIR = path.join(isolatedAgentDirectory, "sessions");
process.once("exit", () => rmSync(isolatedAgentDirectory, { recursive: true, force: true }));
let modulePromise;

async function loadHandlersModule() {
  if (modulePromise) return modulePromise;
  modulePromise = (async () => {
    const outputDirectory = path.join(root, ".artifacts", "test-modules");
    mkdirSync(outputDirectory, { recursive: true });
    const outputFile = path.join(outputDirectory, `handlers-${process.pid}.mjs`);
    await build({
      absWorkingDir: root,
      entryPoints: ["src/agent-host/handlers.ts"],
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

async function captureHandlers() {
  const { registerHandlers } = await loadHandlersModule();
  const handlers = {};
  const events = [];
  registerHandlers({
    handle(next) {
      Object.assign(handlers, next);
    },
    emit(topic, key, data) {
      events.push({ topic, key, data });
    },
  });
  return { handlers, events };
}

test("registerHandlers exposes every contract method exactly once", async () => {
  const { handlers } = await captureHandlers();
  assert.equal(Object.keys(handlers).length, 63);
  for (const method of [
    "host.ping",
    "sessions.list",
    "worktrees.list",
    "git.status",
    "agent.state",
    "channels.list",
    "channels.accountConnect",
    "files.list",
    "files.download",
    "models.list",
    "auth.providers",
    "skills.list",
    "plugins.list",
    "system.allowRoot",
  ]) {
    assert.equal(typeof handlers[method], "function", `${method} must be registered`);
  }
});

test("file, git, worktree, skill, plugin, and system handlers return contract-shaped results", async (t) => {
  const base = mkdtempSync(path.join(tmpdir(), "pi-handler-test-"));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const project = path.join(base, "project");
  mkdirSync(path.join(project, "nested"), { recursive: true });
  const textFile = path.join(project, "hello.txt");
  writeFileSync(textFile, "hello handler tests\n");

  const { handlers } = await captureHandlers();
  assert.deepEqual(await handlers["system.allowRoot"]({ path: project }), { ok: true });
  assert.deepEqual(await handlers["system.validateCwd"]({ path: project }), { ok: true, path: project });

  const listed = await handlers["files.list"]({ path: project });
  assert.equal(
    listed.entries.some((entry) => entry.name === "hello.txt" && entry.type === "file"),
    true,
  );

  const read = await handlers["files.read"]({ path: textFile });
  assert.equal(read.encoding, "utf8");
  assert.equal(read.content, "hello handler tests\n");

  const downloaded = await handlers["files.download"]({ path: textFile });
  assert.equal(Buffer.from(downloaded.base64, "base64").toString("utf8"), "hello handler tests\n");
  assert.equal(downloaded.size, Buffer.byteLength("hello handler tests\n"));

  const meta = await handlers["files.meta"]({ path: textFile });
  assert.equal(meta.language, "text");
  assert.equal(meta.mime, "text/plain");

  const preview = await handlers["files.preview"]({ path: textFile });
  assert.equal(preview.kind, "text");
  assert.equal(preview.content, "hello handler tests\n");

  const index = await handlers["files.index"]({ root: project, query: "hello" });
  assert.equal(Array.isArray(index.files), true);
  assert.equal(index.files.includes("hello.txt"), true);

  const git = await handlers["git.status"]({ path: project });
  assert.equal(git.isGit, false);

  const worktrees = await handlers["worktrees.list"]({ projectRoot: project });
  assert.equal(Array.isArray(worktrees.worktrees), true);
  assert.equal(worktrees.projectRoot, project);

  const agentState = await handlers["agent.state"]({ sessionId: "missing-session" });
  assert.deepEqual(agentState, { running: false });

  const skills = await handlers["skills.list"]({ cwd: project });
  assert.equal(Array.isArray(skills.skills), true);

  const plugins = await handlers["plugins.list"]({ cwd: project });
  assert.equal(typeof plugins, "object");

  const running = await handlers["system.runningCount"]();
  assert.equal(running.count, running.sessionIds.length);

  await handlers["files.watchStart"]({ path: project });
  assert.deepEqual(await handlers["files.watchStop"]({ path: project }), { ok: true });
});

test("session, model configuration, and auth handlers isolate state and preserve error codes", async () => {
  const { handlers } = await captureHandlers();

  const sessions = await handlers["sessions.list"]();
  assert.deepEqual(sessions.sessions, []);
  assert.deepEqual(sessions.runningSessionIds, []);

  await assert.rejects(handlers["sessions.get"]({ id: "missing" }), (error) => error.code === "NOT_FOUND");
  await assert.rejects(handlers["agent.command"]({ sessionId: "missing", command: { type: "abort" } }), (error) =>
    ["NOT_FOUND", "BAD_REQUEST"].includes(error.code),
  );

  assert.deepEqual(await handlers["modelsConfig.get"](), { providers: {} });
  assert.throws(
    () => handlers["modelsConfig.set"]({}),
    (error) => error.code === "BAD_REQUEST",
  );
  assert.deepEqual(await handlers["modelsConfig.set"]({ providers: {} }), { ok: true });

  const invalidModelTest = await handlers["modelsConfig.test"]({});
  assert.deepEqual(invalidModelTest, { ok: false, error: "providerName is required" });

  const oauthProviders = await handlers["auth.providers"]();
  assert.equal(Array.isArray(oauthProviders.providers), true);
  const allProviders = await handlers["auth.allProviders"]();
  assert.equal(Array.isArray(allProviders.providers), true);

  assert.deepEqual(await handlers["auth.setApiKey"]({ provider: "handler-test", key: "secret" }), { ok: true });
  assert.deepEqual(await handlers["auth.deleteApiKey"]({ provider: "handler-test" }), { ok: true });
  assert.deepEqual(await handlers["auth.logout"]({ provider: "handler-test" }), { ok: true });
  assert.deepEqual(await handlers["auth.loginCancel"]({ provider: "handler-test" }), { ok: true });
  await assert.rejects(
    handlers["auth.loginSubmit"]({ provider: "one", token: "two-token", code: "code" }),
    (error) => error.code === "BAD_REQUEST",
  );

  const modelsPath = path.join(isolatedAgentDirectory, "models.json");
  writeFileSync(modelsPath, "{broken json", "utf8");
  assert.throws(
    () => handlers["modelsConfig.get"](),
    (error) => error.code === "PARSE_ERROR",
  );
  assert.equal(readFileSync(modelsPath, "utf8"), "{broken json");
});
