import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { Type } from "typebox";
import { CodemodeSandbox } from "@earendil-works/pi-codemode";
import { createAssistantMessageEventStream, getCurrentSystemPrompt, getCurrentTools } from "@earendil-works/pi-ai";
import {
  ModelRuntime,
  SessionManager,
  SettingsManager,
  createAgentSessionServices,
  createAgentSessionFromServices,
  createCodemodeExtension,
  createToolSearchExtension,
} from "@earendil-works/pi-coding-agent";
import { importTestBundle } from "#test-bundle";
const {
  SessionToolPolicy,
  SessionExecutionHistory,
  ExecutionLogStore,
  setAgentSessionSource,
  SessionPromptPolicy,
  createDesktopPromptExtension,
} = await importTestBundle("pi-104-runtime-regression", {
  packages: "external",
  stdin: {
    resolveDir: import.meta.dirname,
    loader: "ts",
    contents: `
    export {SessionToolPolicy} from './session-tool-policy.ts';
    export {SessionExecutionHistory} from './session-execution-history.ts';
    export {ExecutionLogStore} from './execution-log-store.ts';
    export {setAgentSessionSource} from './session-source.ts';
    export {SessionPromptPolicy,createDesktopPromptExtension} from './session-prompt-policy.ts';`,
  },
});
const { loadPhoton } = await import(
  new URL("./utils/photon.js", import.meta.resolve("@earendil-works/pi-coding-agent"))
);
const usage = {
  input: 1,
  output: 1,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 2,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};
async function fixture(t, { tools, excludeTools, customTools = [], settings = {}, persist = false } = {}) {
  const root = mkdtempSync(path.join(tmpdir(), "pi-104-runtime-")),
    manager = persist ? SessionManager.create(root, path.join(root, "sessions")) : SessionManager.inMemory(root);
  setAgentSessionSource(manager, "local");
  const policy = new SessionToolPolicy(manager, tools),
    history = new SessionExecutionHistory(manager, path.join(root, "desktop")),
    prompt = new SessionPromptPolicy(tools?.length === 0);
  await history.recover();
  const runtime = await ModelRuntime.create({
    modelsPath: null,
    refreshOnCreate: false,
    credentials: {
      async read() {},
      async list() {
        return [];
      },
      async modify() {
        throw new Error("read-only");
      },
      async delete() {
        throw new Error("read-only");
      },
    },
  });
  await runtime.setRuntimeApiKey("anthropic", "offline-fixture");
  const services = await createAgentSessionServices({
    cwd: root,
    agentDir: root,
    modelRuntime: runtime,
    settingsManager: SettingsManager.inMemory({ cacheWarming: "off", ...settings }),
    resourceLoaderOptions: {
      noSkills: true,
      noThemes: true,
      noPromptTemplates: true,
      noContextFiles: true,
      extensionFactories: [
        history.extension(),
        { name: "codemode", builtin: true, factory: createCodemodeExtension({ models: false }) },
        { name: "tool-search", builtin: true, factory: createToolSearchExtension() },
        policy.extension(),
        createDesktopPromptExtension(prompt),
      ],
    },
  });
  const { session } = await createAgentSessionFromServices({
    services,
    sessionManager: manager,
    model: runtime.getModel("anthropic", "claude-sonnet-5-5"),
    customTools,
    ...(tools === undefined ? {} : { tools }),
    ...(excludeTools ? { excludeTools } : {}),
  });
  policy.bind(session);
  await session.bindExtensions({ mode: "rpc" });
  t.after(() => {
    session.dispose();
    rmSync(root, { recursive: true, force: true });
  });
  return { root, manager, session, policy, history, prompt, requests: [] };
}
async function run(f, code, id) {
  let calls = 0;
  f.session.agent.streamFunction = (model, context) => {
    f.requests.push(context);
    const first = ++calls === 1,
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
      usage,
    };
    void Promise.resolve().then(() => {
      stream.push({ type: "done", reason: message.stopReason, message });
      stream.end();
    });
    return stream;
  };
  await f.session.prompt("Offline runtime fixture " + id, { source: "rpc" });
  return f.manager
    .getEntries()
    .filter(
      (entry) => entry.type === "message" && entry.message.role === "toolResult" && entry.message.toolCallId === id,
    )
    .at(-1)?.message;
}

test("SDK wildcard selection retains MCP discovery without granting execution, and exclusions/empty selection remain effective", async (t) => {
  const customTools = ["mcp__fixture__echo", "mcp__other__echo"].map((name) => ({
    name,
    label: name,
    description: "fixture",
    exposure: "deferred",
    parameters: Type.Object({}),
    execute: async () => ({ content: [{ type: "text", text: "unused" }] }),
  }));
  for (const [tools, excludeTools, expected] of [
    [["codemode"], undefined, 2],
    [["codemode", "mcp__fixture__*"], undefined, 1],
    [["codemode"], ["mcp__*"], 0],
    [[], undefined, 0],
  ]) {
    const f = await fixture(t, { tools, excludeTools, customTools });
    assert.equal(f.session.getAllTools().filter((tool) => tool.name.startsWith("mcp__")).length, expected);
    assert.equal(f.policy.isAllowed("mcp__fixture__echo"), false);
    if (!tools.length) assert.deepEqual(f.session.getAllTools(), []);
  }
});

test("Codemode-only mode excludes hidden tool guidelines from the final Desktop prompt while keeping authorized nested reads", async (t) => {
  const f = await fixture(t, {
    tools: ["read", "codemode"],
    settings: { codemode: { mode: "only" } },
    customTools: [
      {
        name: "read",
        label: "Read",
        description: "Fixture reader",
        parameters: Type.Object({ path: Type.String() }),
        promptGuidelines: ["HIDDEN_READ_GUIDELINE_SENTINEL"],
        execute: async () => ({ content: [{ type: "text", text: "READ_FIXTURE" }] }),
      },
    ],
  });
  const result = await run(f, 'text(await tools.read({path:"fixture"}));', "hidden-read");
  assert.equal(result.isError, false);
  assert.match(JSON.stringify(result.content), /READ_FIXTURE/);
  const first = f.requests[0];
  assert.doesNotMatch(first.systemPrompt ?? getCurrentSystemPrompt(first.messages), /HIDDEN_READ_GUIDELINE_SENTINEL/);
  assert.deepEqual(
    (first.tools ?? getCurrentTools(first.messages)).map((tool) => tool.name),
    ["codemode"],
  );
  f.policy.setRequested([]);
  f.session.setActiveToolsByName([]);
  f.prompt.setForceEmpty(true);
  await run(f, 'text("not allowed");', "empty-after-only");
  const last = f.requests.at(-1);
  assert.equal(last.systemPrompt ?? getCurrentSystemPrompt(last.messages), "");
  assert.deepEqual(last.tools ?? getCurrentTools(last.messages), []);
});

test(
  "PNG/JPEG/GIF/WebP and resized images preserve original blocks through history, export and fork after temporary paths disappear",
  { timeout: 20000 },
  async (t) => {
    let effects = 0;
    const f = await fixture(t, {
      tools: ["read", "codemode", "fixture_effect"],
      persist: true,
      customTools: [
        {
          name: "fixture_effect",
          label: "Fixture",
          description: "count one effect",
          parameters: Type.Object({}),
          execute: async () => {
            effects++;
            return { content: [{ type: "text", text: "EFFECT_RECORDED" }] };
          },
        },
      ],
    });
    const photon = await loadPhoton();
    assert.ok(photon, "the packaged image codec must load");
    const small = new photon.PhotonImage(new Uint8Array(4 * 4 * 4).fill(180), 4, 4),
      large = new photon.PhotonImage(new Uint8Array(3200 * 1800 * 4).fill(120), 3200, 1800);
    try {
      writeFileSync(path.join(f.root, "small.png"), small.get_bytes());
      writeFileSync(path.join(f.root, "small.jpg"), small.get_bytes_jpeg(80));
      writeFileSync(path.join(f.root, "small.webp"), small.get_bytes_webp());
      writeFileSync(path.join(f.root, "large.png"), large.get_bytes());
    } finally {
      small.free();
      large.free();
    }
    writeFileSync(
      path.join(f.root, "small.gif"),
      Buffer.from("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7", "base64"),
    );
    const result = await run(
      f,
      'for (const path of ["small.png","small.jpg","small.gif","small.webp","large.png"]) {const value=await tools.read({path});text({path,type:value.type,mimeType:value.mimeType,note:value.note});image(value);if(path==="small.png")image(value);}',
      "images",
    );
    assert.equal(result.isError, false, JSON.stringify(result.content));
    const images = result.content.filter((block) => block.type === "image"),
      text = result.content
        .filter((block) => block.type === "text")
        .map((block) => block.text)
        .join("\n");
    assert.equal(images.length, 6);
    for (const mime of ["image/png", "image/jpeg", "image/gif", "image/webp"])
      assert.ok(
        images.some((image) => image.mimeType === mime),
        mime,
      );
    assert.match(text, /3200/);
    assert.match(text, /"type":"image"/);
    const temporary = [...new Set([...text.matchAll(/\[Image saved to (.*?) \(/g)].map((match) => match[1]))];
    assert.equal(temporary.length, 5);
    t.after(() => temporary.forEach((file) => rmSync(file, { force: true })));
    for (const file of temporary) {
      assert.match(path.basename(file), /^pi-codemode-[a-f0-9]{16}\.(png|jpeg|jpg|gif|webp)$/);
      if (process.platform !== "win32") assert.equal(statSync(file).mode & 0o777, 0o600);
      rmSync(file);
    }
    const native = readFileSync(f.manager.getSessionFile(), "utf8");
    for (const image of images) assert.ok(native.includes(image.data));
    const record = (await f.history.query({ includeContent: true, maxContentBytes: 2097152 })).records.find(
      (entry) => entry.toolCallId === "images",
    );
    assert.equal(record.status, "succeeded");
    assert.equal(record.output, undefined, "temporary image names are not durable file attachments");
    const exported = await f.history.store.exportBundle();
    for (const image of images) assert.ok(JSON.stringify(exported).includes(image.data));
    await f.history.store.copyBranch("image-fork", new Set(f.manager.getBranch().map((entry) => entry.id)));
    await f.history.store.remove();
    const fork = await new ExecutionLogStore("image-fork", path.join(f.root, "desktop")).exportBundle();
    for (const image of images) assert.ok(JSON.stringify(fork).includes(image.data));

    // A failed temporary write keeps the completed tool effect and original image; it does not retry the tool.
    const invalidTmp = path.join(f.root, "not-a-directory");
    writeFileSync(invalidTmp, "fixture");
    const previous = { TMPDIR: process.env.TMPDIR, TEMP: process.env.TEMP, TMP: process.env.TMP };
    try {
      process.env.TMPDIR = process.env.TEMP = process.env.TMP = invalidTmp;
      const failed = await run(
        f,
        'await tools.fixture_effect({});image(await tools.read({path:"small.png"}));',
        "image-write-failure",
      );
      assert.equal(effects, 1);
      assert.ok(failed.content.some((block) => block.type === "image"));
      assert.match(JSON.stringify(failed.content), /could not be saved|failed to save|save.*error|ENOTDIR/i);
    } finally {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  },
);

test(
  "Codemode rejects invalid images, bridge cycles and oversized strings while frozen built-ins and later executions remain usable",
  { timeout: 20000 },
  async () => {
    const cyclic = {};
    cyclic.self = cyclic;
    const sandbox = new CodemodeSandbox({
      timeoutMs: 5000,
      tools: [
        { name: "echo", execute: (args) => args },
        { name: "cyclic", execute: async () => cyclic },
      ],
    });
    try {
      const frozen = await sandbox.execute(
        'Array.prototype.toJSON=()=>null;Object.prototype.toJSON=()=>5;Promise.prototype.then=()=>{};Map.prototype.get=()=>undefined;globalThis.JSON={stringify:()=>"broken"};store("fixture",[1]);return [await tools.echo([2]),JSON.stringify({a:1})];',
      );
      assert.equal(frozen.ok, true);
      assert.deepEqual(frozen.value, [[2], '{"a":1}']);
      assert.deepEqual(frozen.storeWrites.set, { fixture: [1] });
      for (const code of [
        'image({type:"image",data:"not base64",mimeType:"image/png"});',
        "await tools.cyclic({});",
        'try {text("x".repeat(16*1024*1024+1));} catch {}',
        'try {for(let i=0;i<=100000;i++)text("");} catch {}',
      ]) {
        const result = await sandbox.execute(code);
        assert.equal(result.ok, false, code);
        assert.ok(result.error);
      }
      const next = await sandbox.execute("return 4;");
      assert.equal(next.ok, true);
      assert.equal(next.value, 4);
    } finally {
      await sandbox.close();
    }
  },
);
