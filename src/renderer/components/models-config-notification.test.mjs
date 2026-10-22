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
        export function reset() {state.reads=0;state.catalogReads=0;state.writes=[];state.writeResult=null;state.requests=[];state.calls=[];state.sources=[];state.cancelQueue=[];state.startQueue=[];state.subscribeQueue=[];state.config={providers:{}};state.version='one';state.configError=null;state.apiKeyProviders=null;}
        export async function listModels() {state.catalogReads++;return {models:[{...model,name:'Catalog '+state.catalogReads}],catalog:{source:'cache',refreshed:false,aborted:false,warnings:[]}};}
        export async function cancelModelsRefresh() {}
        export async function refreshModels() {throw new Error('Unexpected remote catalog refresh');}
        export async function getModelPreferences() {state.reads++;return state.preferences??{models:[model],enabledModels:null};}
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
          if(method === 'models.routing.get') return {config:{enabled:false,strategy:'thinking',fastThinking:'low',strongThinking:'high',retryFallback:false},version:'routing-v1'};
          if(method === 'settings.advanced.get') return {config:{retry:{maxRetries:3}},version:'advanced-v1'};
          if(method === 'models.catalog') return {models:[{provider:'fixture',modelId:'fast',name:'Fast',type:'chat',available:true,virtual:false},{provider:'fixture',modelId:'strong',name:'Strong',type:'chat',available:true,virtual:false},{provider:'typesafe',modelId:'jev-latest',name:'Jev',type:'classifier',available:true,virtual:false}]};
          if(method === 'modelsConfig.get') {if(state.configError)throw state.configError;return {config:structuredClone(state.config),version:state.version,issues:state.issues};}
          if(method === 'auth.providers')return {providers:[{id:'oauth-fixture',name:'OAuth fixture',usesCallbackServer:false,loggedIn:true}]};
          if(method === 'auth.allProviders')return {providers:state.apiKeyProviders??[{id:'api-fixture',displayName:'API fixture',configured:true,modelCount:1}]};
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
  if (options.apiKeyProviders) testApi.state.apiKeyProviders = options.apiKeyProviders;
  testApi.state.configError = options.configError ?? null;
  testApi.state.issues = options.issues;
  testApi.state.preferences = options.preferences;
  const requests = testApi.state.requests,
    sources = testApi.state.sources,
    timers = [],
    opened = [],
    focusTimers = [],
    focused = [];
  let changed = 0,
    providerFocusCount = 0;
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
        ? (element) => {
            if (element.type === "input") return { focus: () => focused.push(element.props.placeholder) };
            if (element.type === "button" && element.props["aria-label"] === "Add provider")
              return { focus: () => providerFocusCount++ };
            return null;
          }
        : undefined,
    });
  });
  return {
    renderer,
    requests,
    sources,
    opened,
    focused,
    get providerFocusCount() {
      return providerFocusCount;
    },
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
      const items = renderer.root.findAll(
        (node) =>
          node.type === "span" && node.children.includes(label) && typeof node.parent.props.onClick === "function",
      );
      if (items.length) {
        await act(async () => items[0].parent.props.onClick());
        return;
      }
      const search = renderer.root.find(
        (node) => node.type === "input" && node.props["aria-label"] === "Search custom providers and models",
      );
      await act(async () => search.props.onChange({ target: { value: label } }));
      const model = renderer.root.find(
        (node) => node.type === "button" && node.props["aria-label"] === "Edit model " + label,
      );
      await act(async () => model.props.onClick());
      await act(async () => search.props.onChange({ target: { value: "" } }));
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

test("schema-invalid config opens with its providers intact and clears diagnostics after an explicit repair", async (t) => {
  const config = {
    future: { kept: true },
    providers: {
      fixture: {
        api: "openai-completions",
        models: [{ id: "broken", name: "Broken", contextWindow: 0 }],
        modelOverrides: { existing: { maxTokens: 1024 } },
      },
    },
  };
  const fixture = await mount(t, {
    config,
    issues: [{ path: "/providers/fixture/models/0/contextWindow", message: "must be > 0" }],
  });
  assert.match(text(fixture.renderer.root), /All custom providers and overrides are inactive/);
  assert.match(text(fixture.renderer.root), /contextWindow/);
  await fixture.select("broken");
  const detail = fixture.detail("ModelDetail");
  await act(async () => detail.props.onChange({ ...detail.props.model, contextWindow: 4096 }));
  await fixture.click("Save");
  const request = fixture.requests.find((request) => request.method === "modelsConfig.set");
  assert.equal(request.params.config.providers.fixture.models[0].contextWindow, 4096);
  assert.deepEqual(request.params.config.future, { kept: true });
  assert.equal(request.params.config.providers.fixture.modelOverrides.existing.maxTokens, 1024);
  await act(async () => request.resolve({ ok: true, version: "repaired" }));
  assert.ok(!text(fixture.renderer.root).includes("All custom providers and overrides are inactive"));
});

test("fields outside the editor have a manual-repair hint and a disk reload action", async (t) => {
  const fixture = await mount(t, {
    config: { providers: { fixture: { headers: { "X-Invalid": null }, models: [{ id: "kept" }] } } },
    issues: [{ path: "/providers/fixture/headers/X-Invalid", message: "must be string" }],
  });
  assert.match(text(fixture.renderer.root), /edit models.json manually/);
  assert.doesNotMatch(text(fixture.renderer.root), /Open Models settings to correct/);
  testApi.state.config = { providers: { fixture: { headers: { "X-Invalid": "fixed" }, models: [{ id: "kept" }] } } };
  testApi.state.issues = [];
  testApi.state.version = "manual-repair";
  await fixture.click("Reload disk version");
  assert.doesNotMatch(text(fixture.renderer.root), /All custom providers and overrides are inactive/);
  await fixture.click("Save");
  const request = fixture.requests.find((request) => request.method === "modelsConfig.set");
  assert.equal(request.params.config.providers.fixture.headers["X-Invalid"], "fixed");
  assert.equal(request.params.expectedVersion, "manual-repair");
  await act(async () => request.resolve({ ok: true, version: "saved" }));
});

test("Jev search finds TypeSafe and opens its existing API key settings with classifier details", async (t) => {
  const fixture = await mount(t, {
    apiKeyProviders: [
      {
        id: "typesafe",
        displayName: "TypeSafe",
        configured: false,
        modelCount: 1,
        chatModelCount: 0,
        credentialVersion: "typesafe-empty",
        auxiliaryModels: [{ id: "jev-latest", name: "Jev", type: "classifier" }],
      },
    ],
  });
  await fixture.click("+ Add provider");
  const search = fixture.detail("AddProviderPicker").find((node) => node.type === "input");
  await act(async () => search.props.onChange({ target: { value: "Jev" } }));
  const provider = fixture
    .detail("AddProviderPicker")
    .find((node) => node.type === "button" && text(node).includes("TypeSafe"));
  await act(async () => provider.props.onClick());
  assert.match(JSON.stringify(fixture.renderer.toJSON()), /jev-latest/);
  assert.match(JSON.stringify(fixture.renderer.toJSON()), /Decision/);
  const detail = fixture.detail("ApiKeyDetail");
  const secret = detail.find((node) => node.type === "input" && node.props.type === "password");
  await act(async () => secret.props.onChange({ target: { value: "typesafe-fixture-key" } }));
  await fixture.click("Save", detail);
  assert.deepEqual(fixture.requests[0].params, {
    provider: "typesafe",
    key: "typesafe-fixture-key",
    expectedVersion: "typesafe-empty",
  });
  await fixture.reply(0, { ok: true, synchronized: true });
});

test("a configured classifier-only provider shows Jev without an empty chat selection panel", async (t) => {
  const fixture = await mount(t, {
    apiKeyProviders: [
      {
        id: "typesafe",
        displayName: "TypeSafe",
        configured: true,
        modelCount: 1,
        chatModelCount: 0,
        auxiliaryModels: [{ id: "jev-latest", name: "Jev", type: "classifier" }],
      },
    ],
  });
  await fixture.select("TypeSafe");
  const rendered = JSON.stringify(fixture.renderer.toJSON());
  assert.match(rendered, /jev-latest/);
  assert.match(rendered, /Codemode/);
  assert.doesNotMatch(rendered, /No models are currently available|Choose which models appear/);
  assert.equal(
    fixture
      .detail("ApiKeyDetail")
      .findAll((node) => typeof node.type === "function" && node.type.name === "ManagedModelsControl").length,
    0,
  );
});

test("provider picker owns its search and focus lifecycle, supports Escape, and returns a custom selection to the editor", async (t) => {
  const fixture = await mount(t, { captureFocus: true });
  const isPicker = (node) => typeof node.type === "function" && node.type.name === "AddProviderPicker";
  await fixture.click("+ Add provider");
  let escapeStopped = false;
  const escape = {
    key: "Escape",
    preventDefault() {},
    stopPropagation() {
      escapeStopped = true;
    },
  };
  await act(async () =>
    fixture
      .detail("AddProviderPicker")
      .find((node) => node.props.role === "dialog")
      .props.onKeyDown(escape),
  );
  assert.equal(escapeStopped, true, "closing the picker must not also close the parent Settings dialog");
  await fixture.flushFocus();
  assert.deepEqual(fixture.focused, [], "an unmounted picker cannot steal focus");
  assert.equal(fixture.providerFocusCount, 1, "focus returns to the picker trigger");
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
  await act(async () =>
    fixture
      .detail("AddProviderPicker")
      .find((node) => node.props.role === "dialog")
      .props.onKeyDown(escape),
  );
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

test("switching account login to an API key requires confirmation of the original credential version", async (t) => {
  const fixture = await mount(t);
  await fixture.select("API fixture");
  const detail = fixture.detail("ApiKeyDetail"),
    Component = detail.type;
  let reloaded = 0;
  const props = {
    ...detail.props,
    onRefresh() {},
    onReloadCredentials() {
      reloaded++;
    },
    provider: {
      ...detail.props.provider,
      configured: false,
      storedAuthType: "oauth",
      credentialVersion: "confirmed-version",
    },
  };
  await act(async () => fixture.renderer.update(createElement(Component, props)));
  assert.match(text(fixture.renderer.root), /Account login active/);
  assert.equal(
    fixture.renderer.root.findAll((node) => node.type === "button" && text(node) === "Disconnect").length,
    0,
  );
  const input = fixture.renderer.root.find((node) => node.type === "input" && node.props.type === "password");
  await act(async () => input.props.onChange({ target: { value: "sk-ui-fixture" } }));
  await fixture.click("Save");
  assert.equal(fixture.requests.length, 0);
  await act(async () =>
    fixture.renderer.update(
      createElement(Component, { ...props, provider: { ...props.provider, credentialVersion: "external-version" } }),
    ),
  );
  await fixture.click("Switch authentication");
  assert.deepEqual(fixture.requests[0].params, {
    provider: "api-fixture",
    key: "sk-ui-fixture",
    replaceExisting: true,
    expectedVersion: "confirmed-version",
  });
  await fixture.fail(0, "CONFLICT", "Credentials changed");
  assert.equal(reloaded, 1);
  assert.equal(fixture.changed, 0);
});

test("switching an API key to account login waits for confirmation before starting OAuth", async (t) => {
  const fixture = await mount(t);
  await fixture.select("OAuth fixture");
  const detail = fixture.detail("OAuthDetail");
  const props = {
    ...detail.props,
    onRefresh() {},
    provider: {
      ...detail.props.provider,
      loggedIn: false,
      storedAuthType: "api_key",
      credentialVersion: "saved-key-version",
    },
  };
  await act(async () => fixture.renderer.update(createElement(detail.type, props)));
  await fixture.click("Login");
  assert.equal(testApi.state.calls.filter((call) => call.method === "auth.loginStart").length, 0);
  await fixture.click("Cancel");
  assert.equal(testApi.state.calls.filter((call) => call.method === "auth.loginStart").length, 0);
  await fixture.click("Login");
  await fixture.click("Switch authentication");
  const request = testApi.state.calls.find((call) => call.method === "auth.loginStart");
  assert.deepEqual(request.params, {
    provider: "oauth-fixture",
    replaceExisting: true,
    expectedVersion: "saved-key-version",
  });
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

test("routing settings save selected models and strategy, preserving edits after a version conflict", async (t) => {
  const fixture = await mount(t);
  await fixture.click("Auto routing");
  const detail = () => fixture.detail("RoutingSettings");
  const select = async (index, value) =>
    act(async () => detail().findAllByType("select")[index].props.onChange({ target: { value } }));
  await act(async () =>
    detail()
      .findAllByType("input")[0]
      .props.onChange({ target: { checked: true } }),
  );
  await select(0, "classifier");
  await select(1, JSON.stringify(["fixture", "fast"]));
  await select(3, JSON.stringify(["fixture", "strong"]));
  await select(5, JSON.stringify(["typesafe", "jev-latest"]));
  await fixture.click("Save", detail());
  assert.equal(fixture.requests[0].method, "models.routing.set");
  assert.deepEqual(fixture.requests[0].params.config.classifier, { provider: "typesafe", modelId: "jev-latest" });
  assert.equal(fixture.requests[0].params.expectedVersion, "routing-v1");
  await fixture.fail(0, "CONFLICT", "Settings changed");
  assert.equal(detail().findAllByType("select")[5].props.value, JSON.stringify(["typesafe", "jev-latest"]));
  assert.equal(fixture.changed, 0);
  await fixture.click("Save", detail());
  await fixture.reply(1, { config: fixture.requests[1].params.config, version: "routing-v2" });
  assert.equal(fixture.changed, 1);
});

test("advanced configuration blocks malformed JSON and saves per-model overrides with a revision", async (t) => {
  const fixture = await mount(t);
  await fixture.click("Advanced model settings");
  const detail = () => fixture.detail("AdvancedSettings");
  const input = () => detail().findByType("textarea");
  await act(async () => input().props.onChange({ target: { value: "{broken" } }));
  assert.equal(detail().find((node) => node.type === "button" && text(node) === "Save").props.disabled, true);
  await act(async () => input().props.onChange({ target: { value: '{"fixture/fast":{"reserveTokens":512}}' } }));
  await fixture.click("Save", detail());
  assert.equal(fixture.requests[0].method, "settings.advanced.set");
  assert.equal(fixture.requests[0].params.config.compaction.modelOverrides["fixture/fast"].reserveTokens, 512);
  assert.equal(fixture.requests[0].params.config.retry.maxRetries, 3);
  assert.equal(fixture.requests[0].params.expectedVersion, "advanced-v1");
  await fixture.reply(0, { config: fixture.requests[0].params.config, version: "advanced-v2" });
  assert.equal(fixture.changed, 1);
});

test("guided API-key setup masks secrets and clears them before displaying the next field", async (t) => {
  const fixture = await mount(t, {
    apiKeyProviders: [
      {
        id: "cloudflare-workers-ai",
        displayName: "Cloudflare fixture",
        configured: true,
        storedAuthType: "api_key",
        credentialVersion: "key-v1",
        modelCount: 1,
      },
    ],
  });
  await fixture.select("Cloudflare fixture");
  await fixture.click("Configure credentials", fixture.detail("OAuthDetail"));
  assert.equal(testApi.state.calls.find((call) => call.method === "auth.loginStart").params.authType, "api_key");
  await fixture.event(0, { type: "prompt_request", message: "Key", token: "secret", secret: true, placeholder: null });
  const input = () => fixture.detail("OAuthDetail").findByType("input");
  assert.equal(input().props.type, "password");
  await act(async () => input().props.onChange({ target: { value: "fixture-secret" } }));
  await fixture.event(0, {
    type: "prompt_request",
    message: "Account ID",
    token: "account",
    secret: false,
    placeholder: null,
  });
  assert.equal(input().props.type, "text");
  assert.equal(input().props.value, "");
  await fixture.click("Cancel", fixture.detail("OAuthDetail"));
  assert.equal(fixture.changed, 0);
});

test("explicit disk reload replaces an invalid JSON draft even when the stored object is unchanged", async (t) => {
  const overrides = { fixture: { samplingParams: { temperature: 0.2 } } };
  const fixture = await mount(t, {
    config: { providers: { custom: { api: "openai-completions", modelOverrides: overrides } } },
  });
  await fixture.click("Save");
  await fixture.fail(0, "CONFLICT", "External update");
  const input = () => fixture.detail("ProviderDetail").findByType("textarea");
  await act(async () => input().props.onChange({ target: { value: "{invalid" } }));
  testApi.state.version = "new-disk-version";
  await fixture.click("Reload disk version");
  assert.deepEqual(JSON.parse(input().props.value), overrides);
  assert.equal(
    fixture.renderer.root.find((node) => node.type === "button" && text(node) === "Save").props.disabled,
    false,
  );
});

test("discovered models merge into the latest draft, retain custom settings and save only on request", async (t) => {
  const existing = { id: "existing", reasoning: true, thinkingLevelMap: { max: "max" }, contextWindow: 32768 };
  const fixture = await mount(t, {
    config: {
      providers: {
        custom: {
          api: "openai-completions",
          baseUrl: "http://fixture.test/",
          apiKey: "fixture-key",
          models: [existing],
        },
      },
    },
  });
  await fixture.click("Fetch model list");
  assert.equal(fixture.requests[0].method, "modelsConfig.discover");
  assert.equal(fixture.requests[0].params.provider.apiKey, "fixture-key");
  const detail = fixture.detail("ProviderDetail");
  await act(async () =>
    detail.props.onChange({
      ...detail.props.provider,
      modelOverrides: { existing: { samplingParams: { temperature: 0.2 } } },
    }),
  );
  const result = {
    ok: true,
    baseUrl: "http://fixture.test/v1",
    models: [{ id: "existing", name: "Remote name" }, { id: "new", name: "New model" }, { id: "new" }],
  };
  await fixture.reply(0, result);
  const draft = fixture.detail("ProviderDetail").props.provider;
  assert.deepEqual(draft.models, [existing, { id: "new", name: "New model" }]);
  assert.equal(draft.baseUrl, result.baseUrl);
  assert.equal(draft.modelOverrides.existing.samplingParams.temperature, 0.2);
  assert.equal(
    testApi.state.calls.some((call) => call.method === "modelsConfig.set"),
    false,
  );
  await fixture.click("Fetch model list");
  await fixture.reply(1, result);
  assert.match(text(fixture.renderer.toJSON()), /added 0/);
  assert.equal(fixture.detail("ProviderDetail").props.provider.models.length, 2);
  await fixture.click("Save");
  assert.equal(fixture.requests[2].method, "modelsConfig.set");
  assert.deepEqual(fixture.requests[2].params.config.providers.custom, draft);
  await fixture.reply(2, { ok: true, version: "two" });
});

test("discovery ignores results from an edited connection or a deselected provider and permits retry after errors", async (t) => {
  const fixture = await mount(t, {
    config: {
      providers: {
        custom: { api: "openai-completions", baseUrl: "https://old.test/v1", models: [] },
        other: { api: "openai-completions", baseUrl: "https://other.test/v1", models: [] },
      },
    },
  });
  await fixture.click("Fetch model list");
  const detail = fixture.detail("ProviderDetail");
  await act(async () => detail.props.onChange({ ...detail.props.provider, baseUrl: "https://new.test/v1" }));
  await fixture.reply(0, { ok: true, baseUrl: "https://old.test/v1", models: [{ id: "stale" }] });
  assert.equal(fixture.detail("ProviderDetail").props.provider.baseUrl, "https://new.test/v1");
  assert.deepEqual(fixture.detail("ProviderDetail").props.provider.models, []);
  await fixture.click("Fetch model list");
  await fixture.reply(1, { ok: false, error: "Authentication failed", status: 401 });
  assert.match(text(fixture.renderer.toJSON()), /Authentication failed/);
  await fixture.click("Fetch model list");
  await fixture.select("other");
  await fixture.reply(2, { ok: true, baseUrl: "https://new.test/v1", models: [{ id: "stale" }] });
  await fixture.select("custom");
  assert.deepEqual(fixture.detail("ProviderDetail").props.provider.models, []);
  await fixture.click("Fetch model list");
  await fixture.reply(3, { ok: true, baseUrl: "https://new.test/v1", models: [] });
  assert.match(text(fixture.renderer.toJSON()), /returned no models/);
});

test("thinking settings explain opt-in levels and update the supported-level preview when explicitly mapped", async (t) => {
  const fixture = await mount(t, {
    config: {
      providers: { custom: { models: [{ id: "reasoner", reasoning: true, thinkingLevelMap: { minimal: "max" } }] } },
    },
  });
  await fixture.select("reasoner");
  const detail = () => fixture.detail("ModelDetail");
  const preview = () => detail().find((node) => node.props.role === "status");
  assert.match(text(detail()), /Mapping Minimal to max does not enable the Maximum option/);
  assert.ok(!text(preview()).includes("Extra high") && !text(preview()).includes("Maximum"));
  assert.equal(detail().findAll((node) => node.type === "option" && text(node) === "Not enabled").length, 2);
  const maxInput = () =>
    detail().find((node) => node.type === "input" && node.props["aria-label"] === "Maximum: provider value");
  assert.equal(maxInput().props.disabled, true);
  assert.equal(maxInput().props.onFocus, undefined, "focusing a field cannot enable a reasoning level");
  const mode = () =>
    detail().find((node) => node.type === "select" && node.props["aria-label"] === "Maximum: availability");
  await act(async () => mode().props.onChange({ target: { value: "custom" } }));
  assert.equal(maxInput().props.disabled, false);
  assert.equal(detail().props.model.thinkingLevelMap.max, "max");
  assert.match(text(preview()), /Maximum/);
  await act(async () => maxInput().props.onChange({ target: { value: "" } }));
  assert.equal(
    fixture.renderer.root.find((node) => node.type === "button" && text(node) === "Save").props.disabled,
    true,
  );
  await act(async () => maxInput().props.onBlur({ target: { value: "" } }));
  assert.equal(detail().props.model.thinkingLevelMap.max, undefined);
  assert.equal(
    fixture.renderer.root.find((node) => node.type === "button" && text(node) === "Save").props.disabled,
    false,
  );
  assert.ok(!text(preview()).includes("Maximum"));
});

test("custom provider visibility can enable all discovered models without enabling other hidden models", async (t) => {
  const models = [
    { provider: "openai", id: "gpt-6-luna", name: "GPT-6 Luna" },
    { provider: "openai", id: "gpt-6-sol", name: "GPT-6 Sol" },
    { provider: "cliproxy", id: "openai/gpt-6-luna", name: "Proxy Luna" },
    { provider: "cliproxy", id: "kimi-k3", name: "Proxy Kimi" },
  ];
  const enabledModels = ["openai/gpt-6-luna", "offline/keep-this-choice"];
  const fixture = await mount(t, {
    config: { providers: { cliproxy: { api: "openai-responses", models: models.slice(2) } } },
    preferences: { models, enabledModels },
  });
  const detail = fixture.detail("ProviderDetail");
  assert.match(text(detail), /Save newly added models first/);
  assert.match(text(detail), /1 of 2 enabled/);
  const expected = ["cliproxy/kimi-k3", "cliproxy/openai/gpt-6-luna", "offline/keep-this-choice", "openai/gpt-6-luna"];
  testApi.state.writeResult = { models, enabledModels: expected };
  await fixture.click("Enable all", detail);
  assert.deepEqual(testApi.state.writes, [{ cwd: "/project", enabledModels: expected }]);
  assert.match(text(fixture.detail("ProviderDetail")), /2 of 2 enabled/);
  assert.equal(fixture.changed, 1);
  assert.equal(
    testApi.state.calls.some((entry) => entry.method === "modelsConfig.set"),
    false,
  );
});

test("custom model search selects the original model index and keeps unrelated definitions when saving", async (t) => {
  const fixture = await mount(t, {
    config: {
      providers: {
        alpha: { models: [{ id: "untouched", reasoning: true }, { id: "vendor/needed" }] },
        beta: { models: [{ id: "other" }] },
      },
    },
  });
  const search = () =>
    fixture.renderer.root.find(
      (node) => node.type === "input" && node.props["aria-label"] === "Search custom providers and models",
    );
  assert.equal(
    fixture.renderer.root.findAll(
      (node) => node.type === "button" && node.props["aria-label"] === "Edit model vendor/needed",
    ).length,
    0,
  );
  await act(async () => search().props.onChange({ target: { value: "vendor/needed" } }));
  const result = fixture.renderer.root.find(
    (node) => node.type === "button" && node.props["aria-label"] === "Edit model vendor/needed",
  );
  assert.equal(result.props.title, "alpha/vendor/needed");
  await act(async () => result.props.onClick());
  const detail = fixture.detail("ModelDetail");
  assert.equal(detail.props.model.id, "vendor/needed");
  await act(async () => detail.props.onChange({ ...detail.props.model, name: "Edited" }));
  await act(async () => search().props.onChange({ target: { value: "" } }));
  await fixture.click("Save");
  assert.deepEqual(fixture.requests[0].params.config.providers.alpha.models, [
    { id: "untouched", reasoning: true },
    { id: "vendor/needed", name: "Edited" },
  ]);
  assert.deepEqual(fixture.requests[0].params.config.providers.beta.models, [{ id: "other" }]);
  await fixture.reply(0, { ok: true, version: "saved" });
});

test("custom provider sections preserve draft fields and invalid advanced JSON across navigation", async (t) => {
  const fixture = await mount(t, {
    config: { providers: { custom: { api: "openai-completions", baseUrl: "https://old.test/v1" } } },
  });
  const detail = () => fixture.detail("ProviderDetail");
  const url = () =>
    detail().find((node) => node.type === "input" && node.props.placeholder === "https://api.example.com/v1");
  await act(async () => url().props.onChange({ target: { value: "https://new.test/v1" } }));
  await fixture.click("Advanced", detail());
  const advanced = () => detail().findByType("textarea");
  await act(async () => advanced().props.onChange({ target: { value: "{invalid" } }));
  await fixture.click("Connection & discovery", detail());
  assert.equal(url().props.value, "https://new.test/v1");
  assert.equal(
    fixture.renderer.root.find((node) => node.type === "button" && text(node) === "Save").props.disabled,
    true,
  );
  await fixture.click("Advanced", detail());
  assert.equal(advanced().props.value, "{invalid");
  await act(async () => advanced().props.onChange({ target: { value: "{}" } }));
  await fixture.click("Save");
  assert.equal(fixture.requests[0].params.config.providers.custom.baseUrl, "https://new.test/v1");
  await fixture.reply(0, { ok: true, version: "saved" });
});

test("an invalid stored thinking mapping remains editable and clearing it restores save validity", async (t) => {
  const fixture = await mount(t, {
    config: {
      providers: { custom: { models: [{ id: "invalid-map", reasoning: true, thinkingLevelMap: { max: 42 } }] } },
    },
  });
  await fixture.select("invalid-map");
  const save = () => fixture.renderer.root.find((node) => node.type === "button" && text(node) === "Save");
  assert.equal(save().props.disabled, true);
  await fixture.click("Clear all", fixture.detail("ModelDetail"));
  assert.equal(save().props.disabled, false);
  assert.equal(fixture.detail("ModelDetail").props.model.thinkingLevelMap, undefined);
});

test("provider name edits stay in the draft across navigation and commit with the single Save action", async (t) => {
  const provider = {
    api: "openai-completions",
    baseUrl: "https://old.test/v1",
    apiKey: "fixture",
    models: [{ id: "model", thinkingLevelMap: { max: "max" } }],
    future: { keep: true },
  };
  const fixture = await mount(t, { config: { providers: { alpha: provider, beta: { api: "openai-completions" } } } });
  const detail = () => fixture.detail("ProviderDetail");
  const nameInput = () => detail().find((node) => node.type === "input" && node.props.placeholder === "provider-name");
  const mountedDetail = detail();
  for (const value of ["g", "ga", "gamma"]) {
    await act(async () => nameInput().props.onChange({ target: { value } }));
    assert.equal(detail(), mountedDetail, "typing must not remount the editor and lose input focus");
  }
  assert.equal(detail().props.name, "alpha", "provider identity stays stable until Save");
  assert.equal(fixture.renderer.root.findAll((node) => node.type === "button" && text(node) === "Rename").length, 0);
  assert.match(text(fixture.renderer.toJSON()), /Connection or model changes are not saved/);
  await fixture.select("beta");
  await fixture.select("alpha");
  assert.equal(nameInput().props.value, "gamma");
  const url = detail().find((node) => node.type === "input" && node.props.placeholder === "https://api.example.com/v1");
  await act(async () => url.props.onChange({ target: { value: "https://edited.test/v1" } }));
  assert.equal(fixture.requests.length, 0);
  await fixture.click("Save");
  assert.deepEqual(Object.keys(fixture.requests[0].params.config.providers), ["gamma", "beta"]);
  assert.deepEqual(fixture.requests[0].params.providerRenames, { alpha: "gamma" });
  assert.deepEqual(fixture.requests[0].params.config.providers.gamma, {
    ...provider,
    baseUrl: "https://edited.test/v1",
  });
  await fixture.reply(0, { ok: true, version: "renamed" });
  assert.equal(detail().props.name, "gamma");
  assert.equal(nameInput().props.value, "gamma");
  assert.match(text(fixture.renderer.toJSON()), /Connection and model definitions are saved/);
  assert.equal(fixture.changed, 1);
});

test("invalid provider names block Save without dropping the typed name or overwriting another provider", async (t) => {
  const fixture = await mount(t, {
    config: { providers: { alpha: { api: "openai-completions" }, beta: { api: "openai-completions" } } },
  });
  const input = () =>
    fixture
      .detail("ProviderDetail")
      .find((node) => node.type === "input" && node.props.placeholder === "provider-name");
  const save = () => fixture.renderer.root.find((node) => node.type === "button" && text(node) === "Save");
  for (const [value, message] of [
    ["", /cannot be empty/],
    [" beta ", /already exists/],
    ["constructor", /reserved/],
  ]) {
    await act(async () => input().props.onChange({ target: { value } }));
    assert.equal(input().props.value, value);
    assert.equal(save().props.disabled, true);
    assert.match(text(fixture.detail("ProviderDetail")), message);
    assert.equal(fixture.requests.length, 0);
  }
  await act(async () => input().props.onChange({ target: { value: "alpha" } }));
  assert.equal(save().props.disabled, false);
  assert.match(text(fixture.renderer.toJSON()), /Connection and model definitions are saved/);
});

test("a failed rename save retains the renamed draft for a normal save retry", async (t) => {
  const fixture = await mount(t, {
    config: { providers: { alpha: { api: "openai-completions", models: [{ id: "retained" }] } } },
  });
  const input = () =>
    fixture
      .detail("ProviderDetail")
      .find((node) => node.type === "input" && node.props.placeholder === "provider-name");
  await act(async () => input().props.onChange({ target: { value: " gamma " } }));
  await fixture.click("Save");
  await fixture.fail(0, "UNAVAILABLE", "Host unavailable");
  assert.equal(input().props.value, "gamma");
  assert.equal(fixture.changed, 0);
  await fixture.click("Save");
  assert.deepEqual(fixture.requests[1].params.config, fixture.requests[0].params.config);
  assert.deepEqual(fixture.requests[1].params.providerRenames, { alpha: "gamma" });
  assert.equal(fixture.requests[1].params.expectedVersion, "one");
  await fixture.reply(1, { ok: true, version: "renamed" });
  assert.equal(fixture.changed, 1);
});

test("editing a failed rename again keeps the original persisted provider identity", async (t) => {
  const fixture = await mount(t, { config: { providers: { alpha: { api: "openai-completions" } } } });
  const input = () =>
    fixture
      .detail("ProviderDetail")
      .find((node) => node.type === "input" && node.props.placeholder === "provider-name");
  await act(async () => input().props.onChange({ target: { value: "beta" } }));
  await fixture.click("Save");
  await fixture.fail(0, "UNAVAILABLE", "Host unavailable");
  await act(async () => input().props.onChange({ target: { value: "gamma" } }));
  await fixture.click("Save");
  assert.deepEqual(fixture.requests[1].params.providerRenames, { alpha: "gamma" });
});

test("naming a newly added provider does not request a migration for an unsaved identity", async (t) => {
  const fixture = await mount(t, { config: { providers: {} } });
  await fixture.click("+ Add provider");
  const custom = fixture
    .detail("AddProviderPicker")
    .find((node) => node.type === "button" && text(node).includes("OpenAI / Anthropic compatible"));
  await act(async () => custom.props.onClick());
  const input = fixture
    .detail("ProviderDetail")
    .find((node) => node.type === "input" && node.props.placeholder === "provider-name");
  await act(async () => input.props.onChange({ target: { value: "new-provider" } }));
  await fixture.click("Save");
  assert.deepEqual(Object.keys(fixture.requests[0].params.config.providers), ["new-provider"]);
  assert.equal(fixture.requests[0].params.providerRenames, undefined);
});
