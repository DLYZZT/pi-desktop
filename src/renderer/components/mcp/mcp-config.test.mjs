import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { createElement } from "react";
import { act, create } from "react-test-renderer";
import { importTestBundle } from "#test-bundle";
const { McpServerEditor, McpProjectOverrideEditor, McpConfig, McpToolsPanel, api } = await importTestBundle("mcp-ui", {
  stdin: {
    contents:
      'export {McpServerEditor} from "./McpServerEditor.tsx"; export {McpProjectOverrideEditor} from "./McpProjectOverrideEditor.tsx"; export {McpConfig} from "./McpConfig.tsx"; export {McpToolsPanel} from "./McpToolsPanel.tsx"; export * as api from "@/lib/api-client";',
    resolveDir: import.meta.dirname,
    loader: "tsx",
  },
  tsconfig: path.join(import.meta.dirname, "../../../../tsconfig.renderer.json"),
  external: ["react", "react-dom", "react-dom/*", "react-test-renderer"],
  plugins: [
    {
      name: "mcp-ui-api",
      setup(build) {
        build.onResolve({ filter: /^@\/lib\/api-client$/ }, () => ({ path: "api", namespace: "mcp-ui-test" }));
        build.onLoad({ filter: /.*/, namespace: "mcp-ui-test" }, () => ({
          loader: "js",
          contents: `
    export const calls=[]; let handler=async () => undefined; export function respond(value){handler=value;calls.length=0;} export async function call(method,params){calls.push({method,params});return handler(method,params);} export async function subscribe(){return () => {};}
  `,
        }));
      },
    },
  ],
});
async function render(t, element) {
  const previous = globalThis.IS_REACT_ACT_ENVIRONMENT;
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  let renderer;
  await act(async () => {
    renderer = create(element);
  });
  t.after(async () => {
    await act(async () => renderer.unmount());
    globalThis.IS_REACT_ACT_ENVIRONMENT = previous;
  });
  return renderer;
}
const button = (renderer, text) =>
  renderer.root.findAllByType("button").find((node) => node.children.join("") === text);

test("MCP editor preserves unknown fields and validates malformed JSON before saving", async (t) => {
  const saved = [];
  let dirty = 0;
  const renderer = await render(
    t,
    createElement(McpServerEditor, {
      initial: {
        name: "fixture",
        config: {
          command: "node",
          args: ["old"],
          future: { preserved: true },
          env: { TOKEN: "<pi-desktop:saved-secret>" },
        },
      },
      busy: false,
      onDirty: () => dirty++,
      onCancel() {},
      onSave: (...args) => saved.push(args),
    }),
  );
  const args = renderer.root.findByProps({ "aria-label": "Arguments (JSON array)" });
  await act(async () => args.props.onChange({ target: { value: "{broken" } }));
  await act(async () => button(renderer, "Save configuration").props.onClick());
  assert.equal(saved.length, 0);
  await act(async () => args.props.onChange({ target: { value: '["literal argument"]' } }));
  await act(async () => button(renderer, "Save configuration").props.onClick());
  assert.deepEqual(saved[0][1].args, ["literal argument"]);
  assert.equal(saved[0][1].future.preserved, true);
  assert.equal(saved[0][1].env.TOKEN, "<pi-desktop:saved-secret>");
  assert.ok(dirty > 0);
});

test("MCP settings reads and import previews do not connect servers and protect unsaved navigation", async (t) => {
  const ref = { current: null };
  let navigated = 0;
  api.respond(async (method) => {
    if (method === "mcp.config.get") return { scope: "global", revision: "missing", entries: [] };
    if (method === "mcp.import.preview") return { entries: ["fixture"], conflicts: [] };
    throw new Error("Unexpected MCP mutation " + method);
  });
  const renderer = await render(t, createElement(McpConfig, { ref, cwd: null, sessionId: null }));
  assert.deepEqual(
    api.calls.map((entry) => entry.method),
    ["mcp.config.get"],
  );
  await act(async () => button(renderer, "Import JSON").props.onClick());
  await act(async () => button(renderer, "Preview import").props.onClick());
  assert.equal(
    api.calls.some((entry) => entry.method === "mcp.probe" || entry.method === "mcp.import.apply"),
    false,
  );
  await act(async () => ref.current.requestLeave(() => navigated++));
  assert.equal(navigated, 0);
  assert.equal(renderer.root.findAllByProps({ role: "alertdialog" }).length, 1);
  await act(async () => button(renderer, "Keep editing").props.onClick());
  assert.equal(navigated, 0);
  await act(async () => ref.current.requestLeave(() => navigated++));
  await act(async () => button(renderer, "Discard changes").props.onClick());
  assert.equal(navigated, 1);
});

test("MCP permission UI sends only scoped grants and respects unavailable entry points", async (t) => {
  api.respond(async () => ({ adapterActive: true, instances: [], tools: [] }));
  const renderer = await render(
    t,
    createElement(McpToolsPanel, {
      sessionId: "fixture",
      onChanged() {},
      panel: {
        adapterActive: true,
        instances: [],
        entryTools: ["codemode"],
        tools: [
          {
            name: "mcp__fixture__echo",
            originalName: "echo",
            server: "fixture",
            inputSchema: {},
            exposure: "codemode",
            active: false,
            callable: true,
            executionAllowed: false,
          },
        ],
      },
    }),
  );
  const checkbox = renderer.root.findAllByType("input").at(-1);
  await act(async () => checkbox.props.onChange({ target: { checked: true } }));
  assert.deepEqual(api.calls[0], {
    method: "mcp.grants",
    params: { sessionId: "fixture", toolNames: ["mcp__fixture__echo", "codemode"] },
  });
  await act(async () => renderer.root.findAllByType("input")[0].props.onChange({ target: { checked: true } }));
  assert.deepEqual(api.calls[1], {
    method: "mcp.declarations",
    params: { sessionId: "fixture", toolNames: ["codemode"] },
  });
});

test("MCP scope changes capture the requested scope before discard confirmation", async (t) => {
  api.respond(async (_method, params) => ({ scope: params.scope, revision: "missing", entries: [] }));
  const renderer = await render(t, createElement(McpConfig, { cwd: "/fixture", sessionId: null }));
  await act(async () => button(renderer, "Import JSON").props.onClick());
  const event = { target: { value: "project" } };
  await act(async () => renderer.root.findByType("select").props.onChange(event));
  event.target.value = "global";
  await act(async () => button(renderer, "Discard changes").props.onClick());
  assert.equal(renderer.root.findByType("select").props.value, "project");
  assert.equal(api.calls.at(-1).params.scope, "project");
});

test("an old MCP probe cannot update a different project view", async (t) => {
  let finish;
  api.respond(async (method) => {
    if (method === "mcp.config.get")
      return { scope: "global", revision: "fixture", entries: [{ name: "server", config: { command: "fixture" } }] };
    if (method === "mcp.probe")
      return new Promise((resolve) => {
        finish = resolve;
      });
    if (method === "mcp.probe.cancel") return { ok: true };
  });
  const renderer = await render(t, createElement(McpConfig, { cwd: "/old", sessionId: null }));
  await act(async () => {
    button(renderer, "Test connection").props.onClick();
  });
  await act(async () => renderer.update(createElement(McpConfig, { cwd: "/new", sessionId: null })));
  await act(async () => finish({ adapterActive: false, instances: [], tools: [] }));
  assert.equal(button(renderer, "Cancel connection test"), undefined);
  assert.equal(
    renderer.root.findAllByType("summary").some((node) => node.children.join("") === "Last connection test"),
    false,
  );
  assert.ok(api.calls.some((entry) => entry.method === "mcp.probe.cancel"));
});

test("project view edits policy only, and disable and reset never copy inherited transport or secrets", async (t) => {
  let policy;
  const mutations = [];
  const entry = () => ({
    name: "shared",
    scope: "global",
    source: "/agent/mcp.json",
    secretFields: ["headers.Private"],
    config: {
      url: "https://mcp.example.invalid",
      headers: { Private: "<pi-desktop:saved-secret>" },
      auth: { provider: "radius" },
      ...policy,
    },
    projectOverride: { source: "/project/.pi/mcp.json", exists: policy !== undefined, config: policy ?? {} },
  });
  api.respond(async (method, params) => {
    if (method === "mcp.config.get")
      return { scope: params.scope, revision: "both-files", entries: params.scope === "project" ? [entry()] : [] };
    if (method === "mcp.config.upsert") {
      policy = params.config;
      mutations.push(params);
    } else if (method === "mcp.config.remove") {
      policy = undefined;
      mutations.push(params);
    } else throw new Error("Unexpected mutation " + method);
  });
  const renderer = await render(t, createElement(McpConfig, { cwd: "/project", sessionId: null }));
  await act(async () => renderer.root.findByType("select").props.onChange({ target: { value: "project" } }));
  assert.equal(button(renderer, "Restore global settings").props.disabled, true);
  await act(async () => button(renderer, "Disable").props.onClick());
  assert.deepEqual(mutations[0].config, { enabled: false });
  assert.equal(mutations[0].scope, "project");
  assert.equal(mutations[0].expectedRevision, "both-files");
  await act(async () => button(renderer, "Edit").props.onClick());
  const editor = renderer.root.findByType(McpProjectOverrideEditor);
  assert.deepEqual(editor.props.initial.config, { enabled: false });
  assert.equal(renderer.root.findAllByType(McpServerEditor).length, 0);
  await act(async () => button(renderer, "Save configuration").props.onClick());
  assert.deepEqual(mutations[1].config, { enabled: false });
  await act(async () => button(renderer, "Restore global settings").props.onClick());
  assert.equal(mutations[2].scope, "project");
  assert.equal(mutations[2].name, "shared");
  assert.equal(button(renderer, "Restore global settings").props.disabled, true);
});

test("project editor preserves inherit versus empty map and rejects malformed JSON", async (t) => {
  const saved = [];
  const renderer = await render(
    t,
    createElement(McpProjectOverrideEditor, {
      initial: { name: "fixture", config: { enabled: false, exposure: "hidden", toolExposure: { read: "direct" } } },
      busy: false,
      onDirty() {},
      onCancel() {},
      onSave: (_name, config) => saved.push(config),
    }),
  );
  await act(async () => renderer.root.findAllByType("select")[0].props.onChange({ target: { value: "" } }));
  await act(async () => renderer.root.findAllByType("select")[1].props.onChange({ target: { value: "" } }));
  const textarea = renderer.root.findByType("textarea");
  await act(async () => textarea.props.onChange({ target: { value: "{broken" } }));
  await act(async () => button(renderer, "Save configuration").props.onClick());
  assert.equal(saved.length, 0);
  await act(async () => textarea.props.onChange({ target: { value: "{}" } }));
  await act(async () => button(renderer, "Save configuration").props.onClick());
  assert.deepEqual(saved[0], { toolExposure: {} });
  await act(async () => textarea.props.onChange({ target: { value: "" } }));
  await act(async () => button(renderer, "Save configuration").props.onClick());
  assert.deepEqual(saved[1], {});
});
