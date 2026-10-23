import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { Type } from "typebox";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import {
  ModelRuntime,
  SessionManager,
  SettingsManager,
  createAgentSessionServices,
  createAgentSessionFromServices,
} from "@earendil-works/pi-coding-agent";
import { importTestBundle } from "#test-bundle";
import { createDeferred } from "#test-timing";

const { createDesktopCodemodeExtension, SessionToolPolicy, SessionExecutionHistory, setAgentSessionSource } =
  await importTestBundle("codemode-workers", {
    packages: "external",
    stdin: {
      resolveDir: import.meta.dirname,
      loader: "ts",
      contents: `
        export {createDesktopCodemodeExtension} from './codemode-models.ts';
        export {SessionToolPolicy} from './session-tool-policy.ts';
        export {SessionExecutionHistory} from './session-execution-history.ts';
        export {setAgentSessionSource} from './session-source.ts';`,
    },
  });

// Pi 1.4.0 shares two live Codemode workers across every session in the Host process.
delete process.env.PI_CODEMODE_MAX_WORKERS;

const zero = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function createHold() {
  let release = createDeferred();
  let entered = 0;
  const waiters = [];
  return {
    get entered() {
      return entered;
    },
    release() {
      release.resolve();
      release = createDeferred();
    },
    async waitForEntered(count) {
      while (entered < count) await new Promise((resolve) => waiters.push(resolve));
    },
    tool: {
      name: "hold",
      label: "Hold",
      description: "Blocks until the fixture releases it",
      parameters: Type.Object({}),
      async execute(_id, _params, signal) {
        entered++;
        for (const resolve of waiters.splice(0)) resolve();
        await new Promise((resolve, reject) => {
          release.promise.then(resolve);
          signal?.addEventListener("abort", () => reject(new Error("hold aborted")), { once: true });
        });
        return { content: [{ type: "text", text: "released" }], details: undefined };
      },
    },
  };
}

async function fixture(t, hold) {
  const root = mkdtempSync(path.join(tmpdir(), "pi-codemode-workers-"));
  const runtime = await ModelRuntime.create({ modelsPath: null, refreshOnCreate: false });
  await runtime.setRuntimeApiKey("anthropic", "fixture-chat-key");
  const manager = SessionManager.create(root, path.join(root, "sessions"));
  setAgentSessionSource(manager, "local");
  const policy = new SessionToolPolicy(manager, ["codemode", "hold"]);
  const history = new SessionExecutionHistory(manager, path.join(root, "desktop"));
  await history.recover();
  const services = await createAgentSessionServices({
    cwd: root,
    agentDir: root,
    modelRuntime: runtime,
    settingsManager: SettingsManager.inMemory({ cacheWarming: "off" }),
    resourceLoaderOptions: {
      noSkills: true,
      noThemes: true,
      noContextFiles: true,
      noPromptTemplates: true,
      extensionFactories: [
        policy.extension(),
        history.extension(),
        {
          name: "codemode",
          builtin: true,
          factory: createDesktopCodemodeExtension({ isAllowed: () => policy.isAllowed("codemode"), history }),
        },
      ],
    },
  });
  const { session } = await createAgentSessionFromServices({
    services,
    sessionManager: manager,
    model: runtime.getModel("anthropic", "claude-sonnet-5-5"),
    tools: ["codemode", "hold"],
    customTools: [hold.tool],
  });
  policy.bind(session);
  await session.bindExtensions({ mode: "rpc" });
  t.after(() => {
    session.dispose();
    rmSync(root, { recursive: true, force: true });
  });
  return { manager, history, session };
}

function run(f, code, id) {
  let count = 0;
  f.session.agent.streamFunction = (model) => {
    const first = ++count === 1,
      stream = createAssistantMessageEventStream();
    const message = {
      role: "assistant",
      content: first
        ? [{ type: "toolCall", id, name: "codemode", arguments: { code } }]
        : [{ type: "text", text: "done" }],
      api: model.api,
      provider: model.provider,
      model: model.id,
      stopReason: first ? "toolUse" : "stop",
      timestamp: Date.now(),
      usage: zero,
    };
    void Promise.resolve().then(() => {
      stream.push({ type: "done", reason: message.stopReason, message });
      stream.end();
    });
    return stream;
  };
  return f.session.prompt("Codemode worker fixture", { source: "rpc" }).then(() => result(f, id));
}

function result(f, id) {
  const message = f.manager
    .getEntries()
    .filter((e) => e.message?.role === "toolResult" && e.message.toolCallId === id)
    .at(-1)?.message;
  return message && { isError: message.isError, text: message.content.map((block) => block.text ?? "").join("\n") };
}

async function record(f, id) {
  return (await f.history.query({ limit: 20 })).records.find((r) => r.toolCallId === id);
}

async function waitFor(check, label) {
  const deadline = Date.now() + 5000;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test(
  "a third session queues for a shared Codemode worker, cancels and times out without running, then recovers",
  { timeout: 30000 },
  async (t) => {
    const hold = createHold();
    const [a, b, c] = [await fixture(t, hold), await fixture(t, hold), await fixture(t, hold)];
    const holding = [
      run(a, "await tools.hold({});text('A done')", "a"),
      run(b, "await tools.hold({});text('B done')", "b"),
    ];
    await hold.waitForEntered(2);

    // Queued: the call is recorded as running, but its script has not started.
    const queued = run(c, "text('C ran')", "queued");
    await waitFor(async () => (await record(c, "queued"))?.status === "running", "the queued call to start waiting");
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(result(c, "queued"), undefined, "no worker may start while both are held");
    await c.session.abort();
    const cancelled = await queued;
    assert.equal(cancelled.isError, true);
    assert.doesNotMatch(cancelled.text, /C ran/);
    assert.equal((await record(c, "queued")).status, "cancelled");

    // A script deadline shorter than the worker wait fails before the script runs.
    const late = await run(c, '// @options: {"timeout_ms": 200}\ntext("deadline ran")', "deadline");
    assert.equal(late.isError, true);
    assert.match(late.text, /while waiting for a free codemode worker/);
    assert.doesNotMatch(late.text, /deadline ran/);
    assert.equal((await record(c, "deadline")).status, "failed");

    hold.release();
    const [first, second] = await Promise.all(holding);
    assert.equal(first.isError, false, first.text);
    assert.match(first.text, /A done/);
    assert.equal(second.isError, false, second.text);

    // Cancelled and timed-out waits must not leak a reservation.
    const recovered = await run(c, "text('C ran')", "recovered");
    assert.equal(recovered.isError, false, recovered.text);
    assert.match(recovered.text, /C ran/);
    for (const [f, id] of [
      [a, "a"],
      [b, "b"],
      [c, "recovered"],
    ])
      assert.equal((await record(f, id)).status, "succeeded");
  },
);
