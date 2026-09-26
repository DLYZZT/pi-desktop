import assert from "node:assert/strict";
import path from "node:path";
import test, { after } from "node:test";
import { createElement, createRef } from "react";
import { act, create } from "react-test-renderer";
import { importTestBundle } from "#test-bundle";
import { RpcError } from "../../contract/types.ts";

const previousActEnvironment = globalThis.IS_REACT_ACT_ENVIRONMENT;
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
after(() => {
  if (previousActEnvironment === undefined) delete globalThis.IS_REACT_ACT_ENVIRONMENT;
  else globalThis.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment;
});

const { SkillsConfig, PluginsConfig, testApi } = await importTestBundle("resource-config-rpc", {
  stdin: {
    contents:
      'export {SkillsConfig} from "./SkillsConfig.tsx"; export {PluginsConfig} from "./PluginsConfig.tsx"; export * as testApi from "@/lib/api-client";',
    resolveDir: import.meta.dirname,
    loader: "ts",
  },
  tsconfig: path.join(import.meta.dirname, "../../../tsconfig.renderer.json"),
  external: ["react", "react-dom", "react-dom/*"],
  plugins: [
    {
      name: "resource-rpc-fixture",
      setup(build) {
        build.onResolve({ filter: /^(?:@\/lib\/api-client|\.\/api-client)$/ }, () => ({
          path: "api",
          namespace: "resource-test",
        }));
        build.onResolve({ filter: /^@\/i18n$/ }, () => ({ path: "i18n", namespace: "resource-test" }));
        build.onLoad({ filter: /.*/, namespace: "resource-test" }, ({ path }) => ({
          contents:
            path === "i18n"
              ? `
        const t = (_key, fallback) => fallback;
        export function useI18n() {return {t,language:'en'};}
      `
              : `
        export const requests = [];
        export function reset(){requests.length=0;}
        export function call(method,params){
          let resolve,reject;
          const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});
          requests.push({method,params,resolve,reject,settled:false});
          return promise;
        }
        export const agentCommand = (sessionId,command) => call('agent.command',{sessionId,command});
      `,
        }));
      },
    },
  ],
});

const text = (node) => (typeof node === "string" ? node : (node.children?.map(text).join("") ?? ""));
const skill = (name, cwd = "/one") => ({
  name,
  description: `${name} description`,
  filePath: `${cwd}/${name}/SKILL.md`,
  baseDir: `${cwd}/${name}`,
  disableModelInvocation: false,
  sourceInfo: { scope: "project" },
});
const counts = { extensions: 0, skills: 1, prompts: 0, themes: 0 };
const plugin = (patch = {}) => ({
  source: "npm:fixture-plugin",
  scope: "project",
  filtered: false,
  disabled: false,
  installedPath: "/one/plugin",
  packageName: "fixture-plugin",
  version: "1.0.0",
  counts,
  resources: [],
  status: "loaded",
  ...patch,
});
const plugins = (packages) => ({ packages, totals: counts, diagnostics: [] });

async function mount(t, kind, patch = {}) {
  testApi.reset();
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  const bridgeActions = [],
    listeners = new Map();
  globalThis.window = {
    addEventListener(name, callback) {
      listeners.set(name, callback);
    },
    removeEventListener(name, callback) {
      if (listeners.get(name) === callback) listeners.delete(name);
    },
    piBridge: {
      platform: "darwin",
      async performToolchainAction(action) {
        bridgeActions.push(action);
      },
      async rescanToolchains() {},
    },
  };
  t.mock.method(globalThis, "fetch", () => {
    throw new Error("A migrated resource page must not use the fetch shim");
  });
  const ref = createRef();
  const Component = kind === "skills" ? SkillsConfig : PluginsConfig;
  let props = { cwd: "/one", sessionId: "session-one", embedded: true, onClose() {}, ...patch };
  let renderer;
  t.after(async () => {
    await act(async () => renderer.unmount());
    if (previousWindow) Object.defineProperty(globalThis, "window", previousWindow);
    else delete globalThis.window;
  });
  await act(async () => {
    renderer = create(createElement(Component, { ...props, ...(kind === "skills" ? { ref } : {}) }));
  });
  return {
    renderer,
    ref,
    bridgeActions,
    listeners,
    requests: testApi.requests,
    text: () => JSON.stringify(renderer.toJSON()),
    next(method) {
      const request = testApi.requests.find((request) => request.method === method && !request.settled);
      assert.ok(request, `Missing ${method}`);
      return request;
    },
    async reply(method, data) {
      const request = this.next(method);
      request.settled = true;
      await act(async () => request.resolve(data));
      return request;
    },
    async reject(method, error) {
      const request = this.next(method);
      request.settled = true;
      await act(async () => request.reject(error));
      return request;
    },
    async update(patch) {
      props = { ...props, ...patch };
      await act(async () =>
        renderer.update(createElement(Component, { ...props, ...(kind === "skills" ? { ref } : {}) })),
      );
    },
    async click(label, within = renderer.root) {
      const button = within.find(
        (node) =>
          typeof node.type === "string" &&
          typeof node.props.onClick === "function" &&
          (node.props["aria-label"] === label || text(node) === label),
      );
      await act(async () => {
        void button.props.onClick();
      });
    },
  };
}

test("skills RPC listing ignores late success and errors after switching projects", async (t) => {
  const fixture = await mount(t, "skills");
  const old = fixture.next("skills.list");
  old.settled = true;
  assert.deepEqual(old.params, { cwd: "/one" });
  await fixture.update({ cwd: "/two" });
  assert.deepEqual(fixture.next("skills.list").params, { cwd: "/two" });
  await fixture.reply("skills.list", { skills: [skill("current", "/two")] });
  await fixture.reply("skills.getContent", { content: "CURRENT CONTENT" });
  await act(async () => old.resolve({ skills: [skill("old")] }));
  assert.doesNotMatch(fixture.text(), /old description/);
  assert.match(fixture.text(), /current description/);
  await fixture.update({ cwd: "/three" });
  const failed = fixture.next("skills.list");
  failed.settled = true;
  await fixture.update({ cwd: "/four" });
  await fixture.reply("skills.list", { skills: [skill("latest", "/four")] });
  await fixture.reply("skills.getContent", { content: "LATEST CONTENT" });
  await act(async () => failed.reject(new RpcError({ code: "CLOSED", message: "Old connection" })));
  assert.match(fixture.text(), /latest description/);
  assert.doesNotMatch(fixture.text(), /Old connection|current description/);
});

test("skill navigation exposes native buttons and preserves unsaved-change guards", async (t) => {
  const fixture = await mount(t, "skills");
  await fixture.reply("skills.list", { skills: [skill("first"), skill("second")] });
  await fixture.reply("skills.getContent", { content: "first content" });
  const buttons = () => fixture.renderer.root.findAllByType("button");
  const first = buttons().find((node) => text(node) === "first");
  const second = buttons().find((node) => text(node) === "second");
  assert.ok(first && second, "each skill must be a keyboard-focusable native button");
  assert.equal(first.props.type, "button");
  assert.equal(first.props["aria-current"], "true");
  assert.ok(buttons().find((node) => text(node) === "Add skill"));
  await act(async () =>
    fixture.renderer.root.findByType("textarea").props.onChange({ target: { value: "unsaved first" } }),
  );
  await fixture.click("second");
  assert.ok(fixture.renderer.root.find((node) => node.props.role === "dialog"));
  assert.equal(fixture.renderer.root.findByType("textarea").props.value, "unsaved first");
  await fixture.click("Cancel");
  assert.equal(buttons().find((node) => text(node) === "first").props["aria-current"], "true");
  await fixture.click("second");
  await fixture.click("Discard");
  await fixture.reply("skills.getContent", { content: "second content" });
  assert.equal(buttons().find((node) => text(node) === "second").props["aria-current"], "true");
});

test("skill toggling sends typed fields and changes the view only after a successful commit", async (t) => {
  const fixture = await mount(t, "skills");
  const item = skill("fixture");
  await fixture.reply("skills.list", { skills: [item] });
  await fixture.reply("skills.getContent", { content: "original" });
  await fixture.click("Disable skill in model prompt");
  assert.deepEqual(fixture.next("skills.set").params, {
    cwd: "/one",
    filePath: item.filePath,
    disableModelInvocation: true,
  });
  await fixture.reply("skills.set", { ok: true });
  const toggle = () => fixture.renderer.root.find((node) => node.props.role === "switch");
  assert.equal(toggle().props["aria-checked"], false);
  await fixture.click("Enable skill in model prompt");
  await fixture.reject(
    "skills.set",
    new RpcError({ code: "FORBIDDEN", message: "Skill is not loaded for this project" }),
  );
  assert.equal(toggle().props["aria-checked"], false);
  assert.match(fixture.text(), /Skill is not loaded for this project/);
});

test("a failed skill save preserves the draft and blocks leaving until a typed retry commits", async (t) => {
  const fixture = await mount(t, "skills");
  const item = skill("fixture");
  await fixture.reply("skills.list", { skills: [item] });
  await fixture.reply("skills.getContent", { content: "original" });
  const editor = () => fixture.renderer.root.find((node) => node.type === "textarea");
  await act(async () => editor().props.onChange({ target: { value: "edited skill" } }));
  let left = 0;
  await act(async () => fixture.ref.current.requestLeave(() => left++));
  const dialog = () => fixture.renderer.root.find((node) => node.props.role === "dialog");
  await fixture.click("Save", dialog());
  assert.deepEqual(fixture.next("skills.set").params, {
    cwd: "/one",
    filePath: item.filePath,
    content: "edited skill",
  });
  await fixture.reject("skills.set", new RpcError({ code: "FORBIDDEN", message: "Cannot save fixture" }));
  assert.equal(left, 0);
  assert.equal(editor().props.value, "edited skill");
  await fixture.click("Save", dialog());
  await fixture.reply("skills.set", { ok: true });
  assert.equal(left, 1);
  await fixture.reply("skills.list", { skills: [item] });
  assert.equal(fixture.listeners.has("beforeunload"), false);
});

test("skill install capability recovery retries the same package, scope and cwd through RPC", async (t) => {
  const fixture = await mount(t, "skills");
  await fixture.reply("skills.list", { skills: [] });
  await fixture.click("Add skill");
  const search = fixture.renderer.root.find(
    (node) => node.type === "input" && node.props["aria-label"] === "Search skills",
  );
  await act(async () => search.props.onChange({ target: { value: "  fixture  " } }));
  await fixture.click("Search");
  assert.deepEqual(fixture.next("skills.search").params, { query: "fixture" });
  await fixture.reply("skills.search", { results: [{ package: "owner/repo@fixture", installs: 1, url: "" }] });
  await fixture.click("project");
  await fixture.click("Install");
  const expected = { package: "owner/repo@fixture", scope: "project", cwd: "/one" };
  assert.deepEqual(fixture.next("skills.install").params, expected);
  await fixture.reject(
    "skills.install",
    new RpcError({ code: "TOOLCHAIN_CAPABILITY_REQUIRED", message: "Node required", detail: { capability: "js.npx" } }),
  );
  await fixture.click("Install and continue");
  assert.deepEqual(fixture.bridgeActions, [{ action: "install-profile", profileId: "javascript-essentials" }]);
  assert.deepEqual(fixture.next("skills.install").params, expected);
  await fixture.reply("skills.install", { ok: true, output: "Installed fixture" });
  await fixture.reply("skills.list", { skills: [] });
});

test("plugin mutations preserve parameters, structured capability retry and returned snapshots", async (t) => {
  const fixture = await mount(t, "plugins");
  const item = plugin();
  await fixture.reply("plugins.list", plugins([item]));
  await fixture.click("Disable package");
  const expected = { action: "disable", source: item.source, scope: item.scope, cwd: "/one" };
  assert.deepEqual(fixture.next("plugins.set").params, expected);
  await fixture.reject(
    "plugins.set",
    new RpcError({ code: "TOOLCHAIN_CAPABILITY_REQUIRED", message: "Node required", detail: { capability: "js.npx" } }),
  );
  await fixture.click("Install and continue");
  assert.deepEqual(fixture.next("plugins.set").params, expected);
  await fixture.reply("plugins.set", plugins([plugin({ disabled: true, status: "disabled" })]));
  assert.ok(fixture.renderer.root.find((node) => node.props["aria-label"] === "Enable package"));
  await fixture.click("Update");
  assert.equal(fixture.next("plugins.set").params.action, "update");
  await fixture.reject("plugins.set", new RpcError({ code: "INTERNAL", message: "fixture update failed" }));
  assert.match(fixture.text(), /fixture update failed/);
});

test("plugin session reload uses the same session and notifies its parent only after command success", async (t) => {
  let reloads = 0;
  const fixture = await mount(t, "plugins", { onReloaded: () => reloads++ });
  await fixture.reply("plugins.list", plugins([plugin()]));
  await fixture.click("Reload session");
  assert.deepEqual(fixture.next("agent.command").params, { sessionId: "session-one", command: { type: "reload" } });
  assert.equal(reloads, 0);
  await fixture.reply("agent.command", {});
  assert.equal(reloads, 1);
  await fixture.reply("plugins.list", plugins([plugin()]));
  assert.match(fixture.text(), /Session reloaded/);
});

test("plugin installation passes the trimmed source and selected scope without an HTTP envelope", async (t) => {
  const fixture = await mount(t, "plugins");
  await fixture.reply("plugins.list", plugins([]));
  const input = fixture.renderer.root.find(
    (node) => node.type === "input" && node.props.placeholder === "npm:@scope/package",
  );
  await act(async () => input.props.onChange({ target: { value: "  npm:@fixture/plugin@1.0.0  " } }));
  await fixture.click("project");
  await fixture.click("Install");
  assert.deepEqual(fixture.next("plugins.set").params, {
    action: "install",
    source: "npm:@fixture/plugin@1.0.0",
    scope: "project",
    cwd: "/one",
  });
  await fixture.reply("plugins.set", plugins([plugin({ source: "npm:@fixture/plugin@1.0.0" })]));
  assert.match(fixture.text(), /Package installed/);
});
