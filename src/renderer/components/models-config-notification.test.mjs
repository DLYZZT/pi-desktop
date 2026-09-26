import assert from "node:assert/strict";
import path from "node:path";
import test, { after } from "node:test";
import { createElement, useState } from "react";
import { act, create } from "react-test-renderer";
import { importTestBundle } from "#test-bundle";
import { createDeferred } from "#test-timing";

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
        export const state = {reads:0, catalogReads:0, writes:[], writeResult:null};
        const model = {id:'fixture-model',name:'Fixture model',provider:'api-fixture',reasoning:false,input:['text'],contextWindow:4096,maxTokens:512};
        export function reset() {state.reads=0;state.catalogReads=0;state.writes=[];state.writeResult=null;}
        export async function listModels() {state.catalogReads++;return {models:[{...model,name:'Catalog '+state.catalogReads}],catalog:{source:'cache',refreshed:false,aborted:false,warnings:[]}};}
        export async function cancelModelsRefresh() {}
        export async function refreshModels() {throw new Error('Unexpected remote catalog refresh');}
        export async function getModelPreferences() {state.reads++;return {models:[model],enabledModels:null};}
        export async function setModelPreferences(cwd, enabledModels) {state.writes.push({cwd,enabledModels});return await state.writeResult;}
        export async function call(method) {if(method !== 'auth.loginCancel') throw new Error('Unexpected RPC: '+method);return {};}
      `,
        }));
      },
    },
  ],
});

const text = (node) => (typeof node === "string" ? node : (node.children?.map(text).join("") ?? ""));
const jsonResponse = (data, status = 200) => new globalThis.Response(JSON.stringify(data), { status });

async function mount(t) {
  testApi.reset();
  const requests = [],
    sources = [],
    timers = [];
  let changed = 0;
  const nativeTimeout = globalThis.setTimeout;
  t.mock.method(globalThis, "setTimeout", (callback, delay, ...args) => {
    if (delay !== 2000) return nativeTimeout(callback, delay, ...args);
    const timer = {};
    timers.push({ timer, callback });
    return timer;
  });
  const previousSource = Object.getOwnPropertyDescriptor(globalThis, "EventSource");
  globalThis.EventSource = class {
    constructor(url) {
      this.url = url;
      this.closed = false;
      sources.push(this);
    }
    close() {
      this.closed = true;
    }
  };
  t.mock.method(globalThis, "fetch", async (url, options = {}) => {
    const method = options.method ?? "GET";
    if (method === "GET") {
      if (url === "/api/models-config") return jsonResponse({ config: { providers: {} }, version: "one" });
      if (url === "/api/auth/providers")
        return jsonResponse({
          providers: [{ id: "oauth-fixture", name: "OAuth fixture", usesCallbackServer: false, loggedIn: true }],
        });
      if (url === "/api/auth/all-providers")
        return jsonResponse({
          providers: [{ id: "api-fixture", displayName: "API fixture", configured: true, modelCount: 1 }],
        });
      throw new Error("Unexpected read: " + url);
    }
    const request = { ...createDeferred(), url, method, options };
    requests.push(request);
    return request.promise;
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
  });
  await act(async () => {
    renderer = create(createElement(Host));
  });
  return {
    renderer,
    requests,
    sources,
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
    async reply(index, data, status = 200) {
      await act(async () => requests[index].resolve(jsonResponse(data, status)));
    },
    detail(name) {
      return renderer.root.find((node) => typeof node.type === "function" && node.type.name === name);
    },
  };
}

test("API key save and removal notify the parent once after each committed change, including sync warnings", async (t) => {
  const fixture = await mount(t);
  assert.equal(fixture.changed, 0);
  assert.equal(testApi.state.catalogReads, 1);
  await fixture.select("API fixture");
  const input = fixture.detail("ApiKeyDetail").find((node) => node.type === "input" && node.props.type === "password");
  await act(async () => input.props.onChange({ target: { value: "nonsecret-fixture-key" } }));
  await fixture.click("Save", fixture.detail("ApiKeyDetail"));
  assert.equal(fixture.changed, 0);
  assert.equal(fixture.requests[0].method, "POST");
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
  assert.equal(fixture.requests[1].method, "DELETE");
  await fixture.reply(1, { ok: true, synchronized: true });
  assert.equal(fixture.changed, 2);
  assert.equal(testApi.state.reads, 3);
  assert.equal(testApi.state.catalogReads, 3);
});

test("failed credential mutations do not publish a model catalog change", async (t) => {
  const fixture = await mount(t);
  await fixture.select("API fixture");
  await fixture.click("Disconnect", fixture.detail("ApiKeyDetail"));
  await fixture.reply(0, { error: "Failed to remove fixture" }, 500);
  assert.equal(fixture.changed, 0);
  assert.equal(testApi.state.reads, 1);
  await fixture.select("OAuth fixture");
  await fixture.click("Disconnect", fixture.detail("OAuthDetail"));
  await fixture.reply(1, { error: "Failed to logout fixture" }, 500);
  assert.equal(fixture.changed, 0);
  assert.equal(testApi.state.reads, 1);
  assert.equal(testApi.state.catalogReads, 1);
});

test("OAuth completion and logout notify after commit while progress and duplicate completion stay silent", async (t) => {
  const fixture = await mount(t);
  await fixture.select("OAuth fixture");
  await fixture.click("Re-login", fixture.detail("OAuthDetail"));
  assert.equal(fixture.sources.length, 1);
  await act(async () =>
    fixture.sources[0].onmessage({ data: JSON.stringify({ type: "progress", message: "Waiting" }) }),
  );
  assert.equal(fixture.changed, 0);
  await act(async () =>
    fixture.sources[0].onmessage({
      data: JSON.stringify({
        type: "success",
        warning: { code: "MODEL_SYNC_FAILED", message: "Saved; refresh pending" },
      }),
    }),
  );
  assert.equal(fixture.changed, 1);
  assert.equal(fixture.sources[0].closed, true);
  await act(async () => fixture.sources[0].onmessage({ data: JSON.stringify({ type: "success" }) }));
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
  await fixture.reply(0, { success: true, version: "two" });
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
