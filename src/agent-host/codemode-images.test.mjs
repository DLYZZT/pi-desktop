import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync } from "node:fs";
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
  buildSessionStats,
  setAgentSessionSource,
} = await importTestBundle("codemode-images", {
  packages: "external",
  stdin: {
    resolveDir: import.meta.dirname,
    loader: "ts",
    contents: `
    export {createDesktopCodemodeExtension} from './codemode-models.ts';
    export {SessionToolPolicy} from './session-tool-policy.ts';
    export {SessionExecutionHistory} from './session-execution-history.ts';
    export {buildSessionStats} from './session-stats.ts';
    export {setAgentSessionSource} from './session-source.ts';`,
  },
});
const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jB5sAAAAASUVORK5CYII=";
const zero = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};
const requestCode = (prompt = "paint") =>
  `const available=await models.getAvailableOfType("image"); const model=available.find(m=>m.id==="fixture-paint"); const r=await models.generateImages(model,{input:[{type:"text",text:${JSON.stringify(prompt)}}]}); if(r.stopReason!=="stop")throw Error(r.errorMessage); for(const b of r.output)if(b.type==="image")image(b); text("IMAGE_DONE");`;

async function fixture(t, { source = "local", allowed = true } = {}) {
  const root = mkdtempSync(path.join(tmpdir(), "pi-desktop-images-"));
  const requests = [],
    entered = createDeferred(),
    closed = createDeferred();
  const server = createServer(async (req, res) => {
    const parts = [];
    for await (const chunk of req) parts.push(chunk);
    const body = JSON.parse(Buffer.concat(parts).toString());
    requests.push({ body, authorization: req.headers.authorization });
    entered.resolve();
    if (JSON.stringify(body).includes("hold")) {
      res.on("close", () => closed.resolve());
      return;
    }
    if (JSON.stringify(body).includes("reject-image")) {
      res
        .writeHead(400, { "content-type": "application/json" })
        .end(JSON.stringify({ error: { message: "IMAGE_FIXTURE_REJECTED" } }));
      return;
    }
    res.writeHead(200, { "content-type": "application/json" }).end(
      JSON.stringify({
        id: "fixture",
        choices: [
          {
            message: {
              role: "assistant",
              content: "generated",
              images: [{ image_url: { url: "data:image/png;base64," + png } }],
            },
          },
        ],
        usage: { prompt_tokens: 4, completion_tokens: 8 },
      }),
    );
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}/v1`;
  const modelPath = path.join(root, "models.json");
  writeFileSync(modelPath, JSON.stringify({ providers: { openrouter: { baseUrl, apiKey: "fixture-image-key" } } }));
  const runtime = await ModelRuntime.create({
    modelsPath: modelPath,
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
  runtime.registerProvider("openrouter", {
    baseUrl,
    apiKey: "fixture-image-key",
    models: [
      {
        type: "image",
        id: "fixture-paint",
        name: "Fixture painter",
        api: "openrouter-images",
        input: ["text", "image"],
        output: ["image"],
        cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
      },
    ],
  });
  assert.ok(runtime.getModelOfType("image", "openrouter", "fixture-paint"), runtime.getError());
  await runtime.setRuntimeApiKey("anthropic", "fixture-chat-key");
  const manager = SessionManager.create(root, path.join(root, "sessions"));
  setAgentSessionSource(manager, source);
  const policy = new SessionToolPolicy(manager, ["codemode"]);
  const history = new SessionExecutionHistory(manager, path.join(root, "desktop"));
  await history.recover();
  const access = { isAllowed: () => allowed && policy.isAllowed("codemode"), history };
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
  return { root, manager, policy, history, session, runtime, requests, entered, closed, access };
}
async function run(f, code, id = "image-call") {
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
  await f.session.prompt("Image fixture", { source: "rpc" });
  return f.manager
    .getEntries()
    .filter((e) => e.message?.role === "toolResult" && e.message.toolCallId === id)
    .at(-1)?.message;
}

test("Codemode images use real SDK HTTP transport, persist original nested input/results and count usage once", async (t) => {
  const f = await fixture(t);
  const result = await run(f, requestCode());
  assert.equal(result.isError, false, JSON.stringify(result.content));
  assert.equal(f.requests.length, 1);
  assert.equal(f.requests[0].authorization, "Bearer fixture-image-key");
  assert.ok(result.content.some((b) => b.type === "image" && b.data === png));
  assert.equal(result.usage.input, 4);
  assert.equal(result.usage.output, 8);
  const records = (await f.history.query({ includeContent: true })).records;
  const child = records.find((r) => r.toolName === "models.generateImages");
  assert.equal(child.status, "succeeded");
  assert.equal(child.parentToolCallId, "image-call");
  assert.equal(child.arguments.value.input[0].text, "paint");
  assert.ok(child.result.value.content.some((b) => b.type === "image" && b.data === png));
  assert.equal(
    buildSessionStats(f.manager.getEntries(), { sessionId: f.manager.getSessionId() }).cost,
    result.usage.cost.total,
  );
  const imagePath = result.content
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("\n")
    .match(/Image saved to (.+?\.png)/)?.[1];
  assert.ok(imagePath && existsSync(imagePath));
  rmSync(imagePath);
  assert.ok(readFileSync(f.manager.getSessionFile(), "utf8").includes(png));
});

test("image API failures and denied permissions preserve the child state without making unauthorized requests", async (t) => {
  const f = await fixture(t);
  let result = await run(f, requestCode("reject-image"), "failure");
  assert.equal(result.isError, true);
  assert.match(JSON.stringify(result.content), /IMAGE_FIXTURE_REJECTED/);
  assert.equal(
    (await f.history.query({})).records.find((r) => r.toolName === "models.generateImages").status,
    "failed",
  );
  f.access.isAllowed = () => false;
  result = await run(f, requestCode(), "denied");
  assert.equal(result.isError, true);
  assert.equal(f.requests.length, 1);
  f.policy.setRequested([]);
  await run(f, requestCode(), "no-tools");
  assert.equal(f.requests.length, 1);
});

test("an image model cannot be called as a classifier", async (t) => {
  const f = await fixture(t);
  const result = await run(
    f,
    'text(await models.getAvailableOfType("classifier")); await models.classify({provider:"openrouter",id:"fixture-paint"},{state:{},questions:{}});',
  );
  assert.equal(result.isError, true);
  assert.equal(f.requests.length, 0);
});

test("revocation after discovery blocks generation at the Host boundary", async (t) => {
  const f = await fixture(t);
  let checks = 0;
  f.access.isAllowed = () => ++checks <= 2;
  const result = await run(f, requestCode());
  assert.equal(result.isError, true);
  assert.equal(f.requests.length, 0);
  assert.equal(
    (await f.history.query({})).records.find((r) => r.toolName === "models.generateImages").status,
    "blocked",
  );
});

test(
  "cancelling a running image request closes HTTP and settles history before the next turn",
  { timeout: 15000 },
  async (t) => {
    const f = await fixture(t);
    const work = run(f, requestCode("hold"), "cancel-image");
    await f.entered.promise;
    await f.session.abort();
    await work;
    await f.closed.promise;
    assert.equal(
      (await f.history.query({})).records.find((r) => r.toolName === "models.generateImages").status,
      "cancelled",
    );
    const next = await run(f, requestCode(), "after-cancel");
    assert.equal(next.isError, false);
  },
);
