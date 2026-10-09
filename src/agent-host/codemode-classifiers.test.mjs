import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
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

const {
  createDesktopCodemodeExtension,
  SessionToolPolicy,
  SessionExecutionHistory,
  ExecutionLogStore,
  buildSessionStats,
  setAgentSessionSource,
} = await importTestBundle("codemode-classifiers", {
  packages: "external",
  stdin: {
    resolveDir: import.meta.dirname,
    loader: "ts",
    contents: `
        export {createDesktopCodemodeExtension} from './codemode-models.ts';
        export {SessionToolPolicy} from './session-tool-policy.ts';
        export {SessionExecutionHistory} from './session-execution-history.ts';
        export {ExecutionLogStore} from './execution-log-store.ts';
        export {buildSessionStats} from './session-stats.ts';
        export {setAgentSessionSource} from './session-source.ts';`,
  },
});
const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jB5sAAAAASUVORK5CYII=";
const questions = {
  relevant: { type: "bool", instructions: "Is this relevant?", criteria: { true: "Relevant", false: "Unrelated" } },
  category: {
    type: "choice",
    instructions: "Classify the task",
    criteria: { bug: "Bug report", feature: "Feature request" },
  },
  priority: { type: "score", instructions: "Rate the priority", criteria: ["Low", "Medium", "High"] },
};
const answers = {
  relevant: { type: "bool", probability: 0.9 },
  category: { type: "choice", choice: "bug", probabilities: { bug: 0.8, feature: 0.2 }, confidence: 0.6 },
  priority: { type: "score", score: 1.7, confidence: 0.8 },
};
const zero = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};
const classifyCode = (state = { text: "PRIVATE_CLASSIFIER_INPUT" }, images) =>
  `const modelsFound=await models.getAvailableOfType("classifier");const model=modelsFound.find(m=>m.id==="fixture-decider");const r=await models.classify(model,${JSON.stringify({ state, questions, ...(images ? { images } : {}) })});if(r.stopReason!=="stop")throw Error(r.errorMessage);text(r.answers);`;

async function fixture(t, { systemOne = false, textOnly = false } = {}) {
  const root = mkdtempSync(path.join(tmpdir(), "pi-desktop-classifiers-"));
  const requests = [],
    entered = createDeferred(),
    closed = createDeferred();
  const server = createServer((req, res) => {
    void (async () => {
      const parts = [];
      for await (const part of req) parts.push(part);
      const body = JSON.parse(Buffer.concat(parts).toString());
      requests.push({ path: req.url, body, authorization: req.headers.authorization });
      entered.resolve();
      if (JSON.stringify(body).includes("HOLD_REQUEST")) {
        res.on("close", () => closed.resolve());
        return;
      }
      if (JSON.stringify(body).includes("REJECT_REQUEST")) {
        res
          .writeHead(400, { "content-type": "application/json" })
          .end(JSON.stringify({ error: { message: "CLASSIFIER_REJECTED" } }));
        return;
      }
      const malformed = JSON.stringify(body).includes("MALFORMED_ANSWER");
      const wireAnswers = systemOne
        ? { ...answers, relevant: { type: "noul", noul: 0.9 } }
        : Object.entries(answers).map(([name, answer]) =>
            answer.type === "bool"
              ? { name, type: "predicate", probability: answer.probability }
              : {
                  ...answer,
                  name,
                  ...(answer.type === "choice"
                    ? {
                        probabilities: Object.entries(answer.probabilities).map(([value, probability]) => ({
                          value,
                          probability,
                        })),
                      }
                    : {}),
                },
          );
      res.writeHead(200, { "content-type": "application/json" }).end(
        JSON.stringify({
          answers: malformed ? {} : wireAnswers,
          usage: { input_tokens: 4, output_tokens: 8 },
        }),
      );
    })().catch((error) => {
      res.writeHead(500).end(String(error));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const runtime = await ModelRuntime.create({
    modelsPath: null,
    refreshOnCreate: false,
    credentials: {
      async read() {},
      async list() {
        return [];
      },
      async modify() {
        throw Error("read-only");
      },
      async delete() {
        throw Error("read-only");
      },
    },
  });
  const provider = systemOne ? "typesafe" : "openai";
  runtime.registerProvider(provider, {
    baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
    apiKey: "sk-classifier-fixture",
    models: [
      {
        type: "classifier",
        id: "fixture-decider",
        name: "Fixture decision model",
        api: systemOne ? "typesafe-system-one" : "openai-decisions",
        input: textOnly || systemOne ? ["text"] : ["text", "image"],
        contextWindow: 10000,
        cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
      },
    ],
  });
  await runtime.setRuntimeApiKey("anthropic", "fixture-chat-key");
  const manager = SessionManager.create(root, path.join(root, "sessions"));
  setAgentSessionSource(manager, "local");
  const policy = new SessionToolPolicy(manager, ["codemode"]);
  const history = new SessionExecutionHistory(manager, path.join(root, "desktop"));
  await history.recover();
  const access = { isAllowed: () => policy.isAllowed("codemode"), history };
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
        { name: "codemode", builtin: true, factory: createDesktopCodemodeExtension(access) },
      ],
    },
  });
  const { session } = await createAgentSessionFromServices({
    services,
    sessionManager: manager,
    model: runtime.getModel("anthropic", "claude-sonnet-5-5"),
    tools: ["codemode"],
  });
  policy.bind(session);
  await session.bindExtensions({ mode: "rpc" });
  t.after(async () => {
    session.dispose();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    rmSync(root, { recursive: true, force: true });
  });
  return { root, runtime, manager, history, policy, access, session, requests, entered, closed };
}

async function run(f, code, id = "decision-call") {
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
  await f.session.prompt("Decision fixture", { source: "rpc" });
  return f.manager
    .getEntries()
    .filter((e) => e.message?.role === "toolResult" && e.message.toolCallId === id)
    .at(-1)?.message;
}

for (const systemOne of [false, true]) {
  test(`classifier ${systemOne ? "System One" : "Decisions"} HTTP calls preserve questions, answers, branch history and usage`, async (t) => {
    const f = await fixture(t, { systemOne });
    assert.ok(!f.runtime.getModels().some((m) => m.id === "fixture-decider"));
    const result = await run(f, classifyCode());
    assert.equal(result.isError, false, JSON.stringify(result.content));
    assert.equal(f.requests.length, 1);
    assert.equal(f.requests[0].path, systemOne ? "/v1/systemone" : "/v1/decisions");
    assert.equal(f.requests[0].authorization, "Bearer sk-classifier-fixture");
    const child = (await f.history.query({ includeContent: true })).records.find(
      (r) => r.toolName === "models.classify",
    );
    assert.equal(child.status, "succeeded");
    assert.equal(child.parentToolCallId, "decision-call");
    assert.deepEqual(child.arguments.value.questions, questions);
    assert.equal(child.arguments.value.state.text, "PRIVATE_CLASSIFIER_INPUT");
    assert.deepEqual(child.result.value.details.answers, answers);
    assert.equal(result.usage.input, 4);
    assert.equal(result.usage.output, 8);
    assert.ok(
      Math.abs(buildSessionStats(f.manager.getEntries(), { sessionId: f.manager.getSessionId() }).cost - 0.00002) <
        1e-12,
    );
    assert.ok(!readFileSync(f.manager.getSessionFile(), "utf8").includes("sk-classifier-fixture"));
    const reopened = new SessionExecutionHistory(f.manager, path.join(f.root, "desktop"));
    assert.ok(JSON.stringify(await reopened.query({ includeContent: true })).includes("PRIVATE_CLASSIFIER_INPUT"));
    await f.history.store.copyBranch("classifier-fork", new Set(f.manager.getBranch().map((e) => e.id)));
    const fork = await new ExecutionLogStore("classifier-fork", path.join(f.root, "desktop")).exportBundle();
    assert.ok(JSON.stringify(fork).includes("PRIVATE_CLASSIFIER_INPUT"));
    assert.ok(JSON.stringify(fork).includes('"probability":0.9'));
  });
}

test("image classification preserves original image data and rejects text-only models before HTTP", async (t) => {
  const image = { type: "image", data: png, mimeType: "image/png" };
  const f = await fixture(t);
  const result = await run(f, classifyCode({ text: "Judge image" }, [image]));
  assert.equal(result.isError, false, JSON.stringify(result.content));
  assert.equal(f.requests[0].body.input[0].content[1].image_url, "data:image/png;base64," + png);
  const child = (await f.history.query({ includeContent: true })).records.find((r) => r.toolName === "models.classify");
  assert.deepEqual(child.arguments.value.images, [image]);
  const textOnly = await fixture(t, { textOnly: true });
  const rejected = await run(textOnly, classifyCode({}, [image]));
  assert.equal(rejected.isError, true);
  assert.equal(textOnly.requests.length, 0);
  assert.match(JSON.stringify(rejected.content), /does not accept image input/);
});

test("classifier failures retain provider errors and billed malformed responses count usage once", async (t) => {
  const f = await fixture(t);
  for (const text of ["REJECT_REQUEST", "MALFORMED_ANSWER"]) {
    const result = await run(f, classifyCode({ text }), text);
    assert.equal(result.isError, true);
    const child = (await f.history.query({ includeContent: true })).records.find((r) => r.parentToolCallId === text);
    assert.equal(child.status, "failed");
    assert.ok(child.result.value.details.errorMessage);
    if (text === "MALFORMED_ANSWER") assert.equal(result.usage.input, 4);
    else assert.match(JSON.stringify(result.content), /CLASSIFIER_REJECTED/);
  }
  assert.ok(
    Math.abs(buildSessionStats(f.manager.getEntries(), { sessionId: f.manager.getSessionId() }).cost - 0.00002) < 1e-12,
  );
});

test("classifier discovery, direct IDs and post-discovery revocation all respect Codemode permission", async (t) => {
  const f = await fixture(t);
  f.access.isAllowed = () => false;
  const denied = await run(f, classifyCode(), "denied");
  assert.equal(denied.isError, true);
  const direct = await run(
    f,
    `await models.classify({provider:"openai",id:"fixture-decider"},${JSON.stringify({ state: {}, questions })});`,
    "direct-denied",
  );
  assert.equal(direct.isError, true);
  let checks = 0;
  f.access.isAllowed = () => ++checks <= 2;
  const revoked = await run(f, classifyCode(), "revoked");
  assert.equal(revoked.isError, true);
  const records = (await f.history.query({})).records.filter((r) => r.toolName === "models.classify");
  assert.equal(records.length, 1);
  assert.equal(records[0].status, "blocked");
  assert.equal(f.requests.length, 0);
});

test("classifier requests cannot run when their durable execution log is unavailable", async (t) => {
  const f = await fixture(t);
  const missing = new SessionExecutionHistory(f.manager, path.join(f.root, "blocked-log"));
  await missing.recover();
  mkdirSync(path.join(f.root, "blocked-log/tool-executions", f.manager.getSessionId() + ".jsonl"), { recursive: true });
  f.access.history = missing;
  const result = await run(f, classifyCode());
  assert.equal(result.isError, true);
  assert.equal(f.requests.length, 0);
});

test("concurrent classifiers have distinct child records and aggregate usage exactly once", async (t) => {
  const f = await fixture(t);
  const result = await run(
    f,
    `const m=(await models.getAvailableOfType("classifier")).find(m=>m.id==="fixture-decider");text(await Promise.all(Array.from({length:6},(_,index)=>models.classify(m,{state:{index},questions:${JSON.stringify(questions)}}))));`,
  );
  assert.equal(result.isError, false, JSON.stringify(result.content));
  const children = (await f.history.query({ limit: 20 })).records.filter((r) => r.toolName === "models.classify");
  assert.equal(children.length, 6);
  assert.equal(new Set(children.map((r) => r.toolCallId)).size, 6);
  assert.ok(children.every((r) => r.status === "succeeded"));
  assert.equal(result.usage.input, 24);
  assert.equal(result.usage.output, 48);
  assert.equal(
    buildSessionStats(f.manager.getEntries(), { sessionId: f.manager.getSessionId() }).cost,
    result.usage.cost.total,
  );
});

test(
  "stopping a classifier aborts HTTP and settles child history before another turn",
  { timeout: 15000 },
  async (t) => {
    const f = await fixture(t);
    const events = [];
    f.session.subscribe((event) => {
      if (event.type === "agent_settled") events.push(event);
    });
    const work = run(
      f,
      `const m=(await models.getAvailableOfType("classifier")).find(m=>m.id==="fixture-decider");await Promise.all(Array.from({length:6},()=>models.classify(m,{state:{text:"HOLD_REQUEST"},questions:${JSON.stringify(questions)}})));`,
      "cancel-decision",
    );
    await f.entered.promise;
    const deadline = Date.now() + 3000;
    while (f.requests.length < 4 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(f.requests.length, 4, "the remaining two model calls must be queued");
    await f.session.abort();
    await work;
    await f.closed.promise;
    assert.equal(events.at(-1).aborted, true);
    const completed = await f.history.query({ limit: 20 });
    assert.ok(completed.records.filter((r) => r.toolName === "models.classify").every((r) => r.status === "cancelled"));
    assert.equal(f.requests.length, 4, "queued calls must not send HTTP after cancellation");
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.deepEqual(
      await f.history.query({ limit: 20 }),
      completed,
      "no model call may keep writing after the turn settles",
    );
    const next = await run(f, classifyCode(), "after-cancel");
    assert.equal(next.isError, false);
    assert.equal(events.at(-1).aborted, false);
  },
);
