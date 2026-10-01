import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { createElement } from "react";
import { act, create } from "react-test-renderer";
import { importTestBundle } from "#test-bundle";
import { createDeferred } from "#test-timing";
import { PRESET_FULL } from "../../shared/tool-presets.ts";

const { SessionToolsConfig, api } = await importTestBundle("session-tools-ui", {
  stdin: {
    contents: 'export {SessionToolsConfig} from "./SessionToolsConfig.tsx"; export * as api from "@/lib/api-client";',
    resolveDir: import.meta.dirname,
    loader: "tsx",
  },
  tsconfig: path.join(import.meta.dirname, "../../../tsconfig.renderer.json"),
  external: ["react", "react-dom", "react-dom/*", "react-test-renderer"],
  plugins: [
    {
      name: "session-tools-ui-environment",
      setup(build) {
        build.onResolve({ filter: /^(?:@\/lib\/api-client|\.\/api-client)$/ }, () => ({
          path: "api",
          namespace: "session-tools-test",
        }));
        build.onLoad({ filter: /.*/, namespace: "session-tools-test" }, () => ({
          loader: "js",
          contents: `
      export const calls=[], subscriptions=[]; let response=async()=>undefined;
      export function respond(next){response=next;calls.length=0;subscriptions.length=0;}
      export async function call(method,params){calls.push({method,params});return response(method,params);}
      export function agentCommand(sessionId,command){return call('agent.command',{sessionId,command});}
      export async function subscribe(topic,key,on){const item={topic,key,on,closed:false};subscriptions.push(item);return()=>{item.closed=true;};}
    `,
        }));
        build.onResolve({ filter: /\.css$/ }, () => ({ path: "css", namespace: "session-tools-css" }));
        build.onLoad({ filter: /.*/, namespace: "session-tools-css" }, () => ({ contents: "", loader: "js" }));
      },
    },
  ],
});
const entries = (active) => PRESET_FULL.map((name) => ({ name, description: name, active: active.includes(name) }));
async function render(t, sessionId) {
  const previous = Object.fromEntries(
    ["window", "IS_REACT_ACT_ENVIRONMENT"].map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]),
  );
  const events = [];
  Object.assign(globalThis, {
    IS_REACT_ACT_ENVIRONMENT: true,
    window: { setInterval: () => 1, clearInterval() {}, dispatchEvent: (event) => events.push(event) },
  });
  let renderer;
  await act(async () => {
    renderer = create(createElement(SessionToolsConfig, { sessionId }));
  });
  t.after(async () => {
    await act(async () => renderer.unmount());
    for (const [name, value] of Object.entries(previous)) {
      if (value) Object.defineProperty(globalThis, name, value);
      else delete globalThis[name];
    }
  });
  return { renderer, events };
}

test("the general tool page enables full entries through session commands without changing MCP grants", async (t) => {
  let active = ["read", "bash", "edit", "write"];
  api.respond(async (method, params) => {
    if (method === "agent.state") return { state: { isPromptRunning: false } };
    if (params.command.type === "get_tools") return entries(active);
    if (params.command.type === "set_tools") {
      active = params.command.toolNames;
      return null;
    }
    if (params.command.type === "set_orchestration_tools") {
      active = [...active.filter((name) => !["codemode", "tool_search"].includes(name)), ...params.command.toolNames];
      return entries(active);
    }
  });
  const { renderer, events } = await render(t, "fixture");
  await act(async () => renderer.root.findByProps({ "data-tool-preset": "full" }).props.onClick());
  assert.equal(renderer.root.findByProps({ "aria-label": "codemode" }).props.checked, true);
  assert.equal(renderer.root.findByProps({ "aria-label": "tool_search" }).props.checked, true);
  await act(async () =>
    renderer.root.findByProps({ "aria-label": "codemode" }).props.onChange({ target: { checked: false } }),
  );
  assert.equal(renderer.root.findByProps({ "aria-label": "codemode" }).props.checked, false);
  assert.equal(renderer.root.findByProps({ "aria-label": "tool_search" }).props.checked, true);
  assert.equal(renderer.root.findByProps({ "data-tool-preset": "full" }).props["aria-checked"], false);
  assert.equal(
    api.calls.some(({ method }) => method.startsWith("mcp.")),
    false,
  );
  assert.ok(events.every((event) => event.detail.sessionId === "fixture"));
  assert.ok(
    api.calls.some(
      ({ params }) => params.command?.type === "set_tools" && params.command.toolNames.includes("codemode"),
    ),
  );
});

test("switching sessions discards late tool snapshots and releases the old subscription", async (t) => {
  const pending = createDeferred();
  api.respond(async (method, params) =>
    method === "agent.state" ? { state: {} } : params.sessionId === "old" ? pending.promise : entries(["read"]),
  );
  const { renderer } = await render(t, "old");
  assert.ok(api.calls.some(({ method, params }) => method === "agent.command" && params.sessionId === "old"));
  await act(async () => renderer.update(createElement(SessionToolsConfig, { sessionId: "new" })));
  await act(async () => pending.resolve(entries(PRESET_FULL)));
  assert.equal(renderer.root.findByProps({ "aria-label": "codemode" }).props.checked, false);
  assert.equal(renderer.root.findByProps({ "aria-label": "tool_search" }).props.checked, false);
  assert.ok(api.subscriptions.filter(({ key }) => key === "old").every(({ closed }) => closed));
});
