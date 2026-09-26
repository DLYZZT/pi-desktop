import assert from "node:assert/strict";
import path from "node:path";
import test, { after } from "node:test";
import { createElement, useState } from "react";
import { act, create } from "react-test-renderer";
import { importTestBundle } from "#test-bundle";
import { createDeferred } from "#test-timing";
import { RpcError } from "../../contract/types.ts";

const previousActEnvironment = globalThis.IS_REACT_ACT_ENVIRONMENT;
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
after(() => {
  if (previousActEnvironment === undefined) delete globalThis.IS_REACT_ACT_ENVIRONMENT;
  else globalThis.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment;
});

const { ModelsConfig, useSessionModels, testApi } = await importTestBundle("models-config-notification", {
  stdin: {
    contents:
      'export {ModelsConfig} from "./ModelsConfig.tsx"; export {useSessionModels} from "../hooks/useSessionModels.ts"; export * as testApi from "@/lib/api-client";',
    resolveDir: import.meta.dirname,
    loader: "ts",
  },
  tsconfig: path.join(import.meta.dirname, "../../../tsconfig.renderer.json"),
  external: ["react", "react-dom", "react-dom/*"],
  plugins: [
    {
      name: "models-notification-fixture",
      setup(build) {
        build.onResolve({ filter: /^@lobehub\/icons\// }, () => ({ path: "icon", namespace: "model-test" }));
        build.onResolve({ filter: /^@\/(i18n|lib\/api-client)$/ }, ({ path }) => ({ path, namespace: "model-test" }));
        build.onLoad({ filter: /.*/, namespace: "model-test" }, ({ path }) => ({
          contents:
            path === "icon"
              ? "export default function Icon() {return null;}"
              : path === "@/i18n"
                ? `
        const t = (_key, fallback) => fallback;
        export function useI18n() {return {t, language:'en'};}
      `
                : `
        export const state = {reads:0, catalogReads:0, writes:[], writeResult:null, requests:[], calls:[], sources:[], cancelQueue:[], startQueue:[], subscribeQueue:[], config:{providers:{}}, version:'one', configError:null};
        const model = {id:'fixture-model',name:'Fixture model',provider:'api-fixture',reasoning:false,input:['text'],contextWindow:4096,maxTokens:512};
        export function reset() {state.reads=0;state.catalogReads=0;state.writes=[];state.writeResult=null;state.requests=[];state.calls=[];state.sources=[];state.cancelQueue=[];state.startQueue=[];state.subscribeQueue=[];state.config={providers:{}};state.version='one';state.configError=null;}
        export async function listModels() {state.catalogReads++;return {models:[{...model,name:'Catalog '+state.catalogReads}],catalog:{source:'cache',refreshed:false,aborted:false,warnings:[]}};}
        export async function cancelModelsRefresh() {}
        export async function refreshModels() {throw new Error('Unexpected remote catalog refresh');}
        export async function getModelPreferences() {state.reads++;return {models:[model],enabledModels:null};}
        export async function setModelPreferences(cwd, enabledModels) {state.writes.push({cwd,enabledModels});return await state.writeResult;}
        const take = (queue, fallback) => { const next=queue.shift(); return typeof next === 'function' ? next() : next ?? fallback; };
        export async function subscribeAuthLogin(provider,on) {
          const entry={provider,on,closed:0};state.sources.push(entry);
          await take(state.subscribeQueue,undefined);
          return () => entry.closed++;
        }
        export async function call(method,params) {
          state.calls.push({method,params});
          if(method === 'auth.loginCancel') return await take(state.cancelQueue,{ok:true});
          if(method === 'auth.loginStart') return await take(state.startQueue,{ok:true,started:true});
          if(method === 'modelsConfig.get') {if(state.configError)throw state.configError;return {config:structuredClone(state.config),version:state.version};}
          if(method === 'auth.providers')return {providers:[{id:'oauth-fixture',name:'OAuth fixture',usesCallbackServer:false,loggedIn:true}]};
          if(method === 'auth.allProviders')return {providers:[{id:'api-fixture',displayName:'API fixture',configured:true,modelCount:1}]};
          let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});
          state.requests.push({method,params,resolve,reject});return promise;
        }
      `,
        }));
      },
    },
  ],
});

const text = (node) => (typeof node === "string" ? node : (node.children?.map(text).join("") ?? ""));

async function mount(t, options = {}) {
  testApi.reset();
  if (options.config) testApi.state.config = options.config;
  testApi.state.configError = options.configError ?? null;
  const requests = testApi.state.requests,
    sources = testApi.state.sources,
    timers = [],
    opened = [],
    focusTimers = [],
    focused = [];
  let changed = 0;
  const nativeTimeout = globalThis.setTimeout;
  t.mock.method(globalThis, "setTimeout", (callback, delay, ...args) => {
    if (options.captureFocus && delay === 30) {
      focusTimers.push(() => callback(...args));
      return {};
    }
    if (delay !== 2000) return nativeTimeout(callback, delay, ...args);
    const timer = {};
    timers.push({ timer, callback });
    return timer;
  });
  const previousSource = Object.getOwnPropertyDescriptor(globalThis, "EventSource");
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  globalThis.EventSource = class {
    constructor() {
      throw new Error("OAuth must use a typed subscription");
    }
  };
  globalThis.window = {
    piBridge: {
      async openExternal(url) {
        opened.push(url);
      },
    },
    open() {
      throw new Error("Unexpected browser fallback");
    },
  };
  t.mock.method(globalThis, "fetch", () => {
    throw new Error("Model configuration must not use fetch");
  });
  let renderer, catalog;
  const addNotice = () => {};
  function Host() {
    const [revision, setRevision] = useState(0);
    catalog = useSessionModels({ isNew: true, cwd: "/project", refreshKey: revision, addNotice });
    return createElement(ModelsConfig, {
      embedded: true,
      cwd: "/project",
      onClose() {},
      onChanged() {
        changed++;
        setRevision((value) => value + 1);
      },
    });
  }
  t.after(async () => {
    await act(async () => renderer.unmount());
    if (previousSource) Object.defineProperty(globalThis, "EventSource", previousSource);
    else delete globalThis.EventSource;
    if (previousWindow) Object.defineProperty(globalThis, "window", previousWindow);
    else delete globalThis.window;
  });
  await act(async () => {
    renderer = create(createElement(Host), {
      createNodeMock: options.captureFocus
        ? (element) =>
            element.type === "input"
              ? {
                  focus: () => focused.push(element.props.placeholder),
                }
              : null
        : undefined,
    });
  });
  return {
    renderer,
    requests,
    sources,
    opened,
    focused,
    async flushFocus() {
      await act(async () => {
        for (const callback of focusTimers.splice(0)) callback();
      });
    },
    get changed() {
      return changed;
    },
    get catalog() {
      return catalog;
    },
    async select(label) {
      const item = renderer.root.find(
        (node) =>
          node.type === "span" && node.children.includes(label) && typeof node.parent.props.onClick === "function",
      );
      await act(async () => item.parent.props.onClick());
    },
    async click(label, within = renderer.root) {
      const button = within.find((node) => node.type === "button" && text(node) === label);
      await act(async () => {
        void button.props.onClick();
      });
    },
    async reply(index, data) {
      await act(async () => requests[index].resolve(data));
    },
    async fail(index, code, message) {
      await act(async () => requests[index].reject(new RpcError({ code, message })));
    },
    async event(index, data) {
      await act(async () => sources[index].on(data));
    },
    detail(name) {
      return renderer.root.find((node) => typeof node.type === "function" && node.type.name === name);
    },
  };
}

test("provider picker owns its search and focus lifecycle, supports Escape, and returns a custom selection to the editor", async (t) => {
  const fixture = await mount(t, { captureFocus: true });
  const isPicker = (node) => typeof node.type === "function" && node.type.name === "AddProviderPicker";
  await fixture.click("+ Add provider");
  await act(async () => fixture.detail("AddProviderPicker").findByType("input").props.onKeyDown({ key: "Escape" }));
  await fixture.flushFocus();
  assert.deepEqual(fixture.focused, [], "an unmounted picker cannot steal focus");
  assert.equal(fixture.renderer.root.findAll(isPicker).length, 0);

  await fixture.click("+ Add provider");
  await fixture.flushFocus();
  assert.deepEqual(fixture.focused, ["Search providers…"]);
  await act(async () =>
    fixture
      .detail("AddProviderPicker")
      .findByType("input")
      .props.onChange({ target: { value: "no-such-provider" } }),
  );
  assert.match(text(fixture.detail("AddProviderPicker")), /No providers match/);
  await act(async () => fixture.detail("AddProviderPicker").findByType("input").props.onKeyDown({ key: "Escape" }));
  await fixture.click("+ Add provider");
  assert.equal(fixture.detail("AddProviderPicker").findByType("input").props.value, "");
  const custom = fixture
    .detail("AddProviderPicker")
    .find((node) => node.type === "button" && text(node).includes("OpenAI / Anthropic compatible"));
  await act(async () => custom.props.onClick());
  assert.equal(fixture.renderer.root.findAll(isPicker).length, 0);
  assert.ok(fixture.detail("ProviderDetail"));
  assert.equal(fixture.requests.length, 0, "choosing a provider edits local config before explicit save");
});

test("API key save and removal notify the parent once after each committed change, including sync warnings", async (t) => {
  const fixture = await mount(t);
  assert.equal(fixture.changed, 0);
  assert.equal(testApi.state.catalogReads, 1);
  await fixture.select("API fixture");
  const input = fixture.detail("ApiKeyDetail").find((node) => node.type === "input" && node.props.type === "password");
  await act(async () => input.props.onChange({ target: { value: "nonsecret-fixture-key" } }));
  await fixture.click("Save", fixture.detail("ApiKeyDetail"));
  assert.equal(fixture.changed, 0);
  assert.equal(fixture.requests[0].method, "auth.setApiKey");
  await fixture.reply(0, {
    ok: true,
    synchronized: false,
    warning: { code: "MODEL_SYNC_FAILED", message: "Saved; refresh pending" },
  });
  assert.equal(fixture.changed, 1);
  assert.equal(testApi.state.reads, 2);
  assert.equal(testApi.state.catalogReads, 2);
  assert.equal(fixture.catalog.modelList[0].name, "Catalog 2");
  await fixture.click("Disconnect", fixture.detail("ApiKeyDetail"));
  assert.equal(fixture.changed, 1);
  assert.equal(fixture.requests[1].method, "auth.deleteApiKey");
  await fixture.reply(1, { ok: true, synchronized: true });
  assert.equal(fixture.changed, 2);
  assert.equal(testApi.state.reads, 3);
  assert.equal(testApi.state.catalogReads, 3);
});

test("failed credential mutations do not publish a model catalog change", async (t) => {
  const fixture = await mount(t);
  await fixture.select("API fixture");
  await fixture.click("Disconnect", fixture.detail("ApiKeyDetail"));
  await fixture.fail(0, "INTERNAL", "Failed to remove fixture");
  assert.equal(fixture.changed, 0);
  assert.equal(testApi.state.reads, 1);
  await fixture.select("OAuth fixture");
  await fixture.click("Disconnect", fixture.detail("OAuthDetail"));
  await fixture.fail(1, "INTERNAL", "Failed to logout fixture");
  assert.equal(fixture.changed, 0);
  assert.equal(testApi.state.reads, 1);
  assert.equal(testApi.state.catalogReads, 1);
});

test("OAuth completion and logout notify after commit while progress and duplicate completion stay silent", async (t) => {
  const fixture = await mount(t);
  await fixture.select("OAuth fixture");
  await fixture.click("Re-login", fixture.detail("OAuthDetail"));
  assert.equal(fixture.sources.length, 1);
  await fixture.event(0, { type: "progress", message: "Waiting" });
  assert.equal(fixture.changed, 0);
  await fixture.event(0, {
    type: "success",
    warning: { code: "MODEL_SYNC_FAILED", message: "Saved; refresh pending" },
  });
  assert.equal(fixture.changed, 1);
  assert.equal(fixture.sources[0].closed, 1);
  await fixture.event(0, { type: "success" });
  assert.equal(fixture.changed, 1);
  await fixture.click("Disconnect", fixture.detail("OAuthDetail"));
  assert.equal(fixture.changed, 1);
  await fixture.reply(0, { ok: true, synchronized: true });
  assert.equal(fixture.changed, 2);
  assert.equal(testApi.state.catalogReads, 3);
});

test("config and model-selection saves keep their existing single committed-change notification", async (t) => {
  const fixture = await mount(t);
  await fixture.click("Save");
  assert.equal(fixture.changed, 0);
  await fixture.reply(0, { ok: true, version: "two" });
  assert.equal(fixture.changed, 1);
  await fixture.select("API fixture");
  const checkbox = fixture
    .detail("ApiKeyDetail")
    .find((node) => node.type === "input" && node.props.type === "checkbox");
  const saved = createDeferred();
  testApi.state.writeResult = saved.promise;
  await act(async () => checkbox.props.onChange({ target: { checked: false } }));
  assert.equal(fixture.changed, 1);
  assert.deepEqual(testApi.state.writes, [{ cwd: "/project", enabledModels: [] }]);
  await act(async () => saved.resolve({ models: [], enabledModels: [] }));
  assert.equal(fixture.changed, 2);
  assert.equal(testApi.state.catalogReads, 3);
});

test("OAuth reset must settle before subscribing and a cancelled reset cannot start a login", async (t) => {
  const fixture = await mount(t);
  await fixture.select("OAuth fixture");
  const reset = createDeferred();
  testApi.state.cancelQueue.push(reset.promise);
  await fixture.click("Re-login", fixture.detail("OAuthDetail"));
  assert.equal(fixture.sources.length, 0);
  await fixture.click("Cancel", fixture.detail("OAuthDetail"));
  await act(async () => reset.resolve({ ok: true }));
  assert.equal(fixture.sources.length, 0);
  assert.equal(testApi.state.calls.filter((call) => call.method === "auth.loginStart").length, 0);
});

test("a late subscription is released without issuing a cancellation against the replacement login", async (t) => {
  const fixture = await mount(t);
  await fixture.select("OAuth fixture");
  const installation = createDeferred();
  testApi.state.subscribeQueue.push(installation.promise);
  await fixture.click("Re-login", fixture.detail("OAuthDetail"));
  await fixture.select("API fixture");
  await fixture.select("OAuth fixture");
  await fixture.click("Re-login", fixture.detail("OAuthDetail"));
  const cancels = testApi.state.calls.filter((call) => call.method === "auth.loginCancel").length;
  assert.equal(fixture.sources.length, 2);
  await act(async () => installation.resolve());
  assert.equal(fixture.sources[0].closed, 1);
  assert.equal(fixture.sources[1].closed, 0);
  assert.equal(testApi.state.calls.filter((call) => call.method === "auth.loginCancel").length, cancels);
  await fixture.event(0, { type: "success" });
  assert.equal(fixture.changed, 0);
  await fixture.event(1, { type: "success" });
  assert.equal(fixture.changed, 1);
});

test("a terminal login event stays authoritative when its start acknowledgement fails late", async (t) => {
  const fixture = await mount(t);
  await fixture.select("OAuth fixture");
  testApi.state.startQueue.push(() => {
    testApi.state.sources.at(-1).on({ type: "success" });
    throw new RpcError({ code: "TIMEOUT", message: "Late start failure" });
  });
  await fixture.click("Re-login", fixture.detail("OAuthDetail"));
  assert.equal(fixture.changed, 1);
  assert.equal(fixture.sources[0].closed, 1);
  assert.doesNotMatch(JSON.stringify(fixture.renderer.toJSON()), /Late start failure/);
});

test("challenge submissions are deduplicated and late replies cannot clear a newer prompt", async (t) => {
  const fixture = await mount(t);
  await fixture.select("OAuth fixture");
  await fixture.click("Re-login", fixture.detail("OAuthDetail"));
  await fixture.event(0, {
    type: "prompt_request",
    message: "First prompt",
    token: "first",
    placeholder: null,
    secret: false,
  });
  const input = () => fixture.detail("OAuthDetail").find((node) => node.type === "input");
  await act(async () => input().props.onChange({ target: { value: "  first answer  " } }));
  const oldKey = input().props.onKeyDown;
  await act(async () => {
    oldKey({ key: "Enter" });
    oldKey({ key: "Enter" });
  });
  assert.equal(fixture.requests.length, 1);
  assert.deepEqual(fixture.requests[0].params, { provider: "oauth-fixture", token: "first", code: "first answer" });
  await fixture.event(0, {
    type: "prompt_request",
    message: "Second prompt",
    token: "second",
    placeholder: null,
    secret: false,
  });
  await act(async () => input().props.onChange({ target: { value: "keep this draft" } }));
  await fixture.fail(0, "TIMEOUT", "Old submit timeout");
  assert.equal(input().props.value, "keep this draft");
  assert.doesNotMatch(JSON.stringify(fixture.renderer.toJSON()), /Old submit timeout/);
  await act(async () => oldKey({ key: "Enter" }));
  assert.equal(fixture.requests.length, 1);
  await act(async () => input().props.onKeyDown({ key: "Enter" }));
  assert.deepEqual(fixture.requests[1].params, { provider: "oauth-fixture", token: "second", code: "keep this draft" });
  await fixture.event(0, { type: "success" });
  await fixture.reply(1, { ok: true });
  assert.equal(fixture.changed, 1);
});

test("OAuth URLs use one native open path and cancelled subscriptions cannot open late URLs", async (t) => {
  const fixture = await mount(t);
  await fixture.select("OAuth fixture");
  await fixture.click("Re-login", fixture.detail("OAuthDetail"));
  await fixture.event(0, { type: "auth", url: "https://fixture.test/authorize", instructions: null, token: "code" });
  assert.deepEqual(fixture.opened, ["https://fixture.test/authorize"]);
  await fixture.event(0, {
    type: "device_code",
    userCode: "TEST",
    verificationUri: "https://fixture.test/device",
    intervalSeconds: 1,
    expiresInSeconds: 60,
  });
  assert.equal(fixture.opened.length, 2);
  await fixture.click("Cancel", fixture.detail("OAuthDetail"));
  await fixture.event(0, { type: "auth", url: "https://fixture.test/late", instructions: null, token: "late" });
  assert.equal(fixture.opened.length, 2);
  assert.equal(fixture.sources[0].closed, 1);
});

test("OAuth selection preserves the option id and waits for the terminal event before publishing credentials", async (t) => {
  const fixture = await mount(t);
  await fixture.select("OAuth fixture");
  await fixture.click("Re-login", fixture.detail("OAuthDetail"));
  await fixture.event(0, {
    type: "select_request",
    message: "Choose method",
    token: "selection",
    options: [{ id: " exact option ", label: "Fixture choice" }],
  });
  await fixture.click("Fixture choice", fixture.detail("OAuthDetail"));
  assert.deepEqual(fixture.requests[0].params, {
    provider: "oauth-fixture",
    token: "selection",
    code: " exact option ",
  });
  await fixture.reply(0, { ok: true });
  assert.equal(fixture.changed, 0);
  await fixture.event(0, { type: "success" });
  assert.equal(fixture.changed, 1);
});

test("failed OAuth reset does not install a subscription or start another backend flow", async (t) => {
  const fixture = await mount(t);
  await fixture.select("OAuth fixture");
  testApi.state.cancelQueue.push(() => {
    throw new RpcError({ code: "CLOSED", message: "Reset unavailable" });
  });
  await fixture.click("Re-login", fixture.detail("OAuthDetail"));
  assert.equal(fixture.sources.length, 0);
  assert.equal(testApi.state.calls.filter((call) => call.method === "auth.loginStart").length, 0);
  assert.match(JSON.stringify(fixture.renderer.toJSON()), /Reset unavailable/);
});

const editorConfig = (url) => ({
  providers: { custom: { api: "openai-completions", baseUrl: url, models: [{ id: "custom-model" }] } },
});

test("typed configuration conflicts retain edits until an explicit reload supplies a new version", async (t) => {
  const fixture = await mount(t, { config: editorConfig("https://initial.test") });
  const field = (value) => fixture.renderer.root.find((node) => node.type === "input" && node.props.value === value);
  await act(async () => field("https://initial.test").props.onChange({ target: { value: "https://edited.test" } }));
  await fixture.click("Save");
  assert.equal(fixture.requests[0].method, "modelsConfig.set");
  assert.equal(fixture.requests[0].params.expectedVersion, "one");
  assert.equal(fixture.requests[0].params.config.providers.custom.baseUrl, "https://edited.test");
  await fixture.fail(0, "CONFLICT", "Version changed");
  assert.ok(field("https://edited.test"));
  assert.equal(fixture.changed, 0);
  assert.match(JSON.stringify(fixture.renderer.toJSON()), /changed outside this editor/);
  testApi.state.config = editorConfig("https://external.test");
  testApi.state.version = "external-version";
  await fixture.click("Reload disk version");
  assert.ok(field("https://external.test"));
  await fixture.click("Save");
  assert.equal(fixture.requests[1].params.expectedVersion, "external-version");
  await fixture.reply(1, { ok: true, version: "saved-version" });
  assert.equal(fixture.changed, 1);
});

test("failed configuration reads block saving instead of replacing the disk file with an empty config", async (t) => {
  const fixture = await mount(t, {
    configError: new RpcError({ code: "FORBIDDEN", message: "Fixture access denied" }),
  });
  const save = fixture.renderer.root.find((node) => node.type === "button" && text(node) === "Save");
  assert.equal(save.props.disabled, true);
  assert.match(JSON.stringify(fixture.renderer.toJSON()), /Fixture access denied/);
  assert.equal(fixture.requests.length, 0);
});

test("model connection results preserve endpoint status and latency separately from RPC errors", async (t) => {
  const fixture = await mount(t, { config: editorConfig("https://model.test") });
  await fixture.select("custom-model");
  await fixture.click("Test", fixture.detail("ModelDetail"));
  assert.equal(fixture.requests[0].method, "modelsConfig.test");
  assert.equal(fixture.requests[0].params.providerName, "custom");
  assert.equal(fixture.requests[0].params.model.id, "custom-model");
  await fixture.reply(0, { ok: false, error: "Endpoint denied", status: 401, latencyMs: 7 });
  assert.match(JSON.stringify(fixture.renderer.toJSON()), /Endpoint denied/);
  assert.match(JSON.stringify(fixture.renderer.toJSON()), /HTTP 401/);
  await fixture.click("Test", fixture.detail("ModelDetail"));
  await fixture.reply(1, { ok: true, responseText: "OK", status: 200, latencyMs: 3 });
  assert.match(JSON.stringify(fixture.renderer.toJSON()), /Connected/);
});
