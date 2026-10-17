import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import { createElement } from "react";
import { act, create } from "react-test-renderer";
import { importTestBundle } from "#test-bundle";
const { useSessionToolSelection, api } = await importTestBundle("session-shell-choice", {
  stdin: {
    resolveDir: import.meta.dirname,
    loader: "ts",
    contents:
      'export {useSessionToolSelection} from "./useSessionToolSelection.ts"; export * as api from "@/lib/api-client";',
  },
  tsconfig: path.join(import.meta.dirname, "../../../tsconfig.renderer.json"),
  external: ["react"],
  plugins: [
    {
      name: "shell-selection-api",
      setup(build) {
        build.onResolve({ filter: /^@\/lib\/(?:api-client|agent-client)$/ }, () => ({
          path: "api",
          namespace: "shell-test",
        }));
        build.onLoad({ filter: /.*/, namespace: "shell-test" }, () => ({
          contents: `
      export const state={choices:[],tools:[],requests:[],failure:false,hold:null};
      export const call=async (method)=>{state.requests.push({method});return {codingTools:state.choices};};
      export const sendAgentCommand=async (id,command)=>{state.requests.push({id,...command});
        if(command.type==='get_tools')return state.tools;
        if(state.hold)await state.hold;
        if(state.failure)throw new Error('save failed');return null;};`,
        }));
      },
    },
  ],
});

test("permission presets use the configured shell and retain no-tools after a failed save", async (t) => {
  const saved = Object.getOwnPropertyDescriptor(globalThis, "IS_REACT_ACT_ENVIRONMENT");
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  api.state.requests.length = 0;
  api.state.failure = false;
  api.state.hold = null;
  api.state.choices = [
    ...["read", "edit", "write", "grep", "find", "ls", "powershell"].map((name) => ({ name, available: true })),
    { name: "bash", available: false },
  ];
  const sessionIdRef = { current: null },
    ensuringNewSessionRef = { current: null };
  let current,
    preset = "default",
    owner = "first",
    renderer;
  function Fixture() {
    current = useSessionToolSelection({
      cwd: "/workspace",
      owner,
      sessionIdRef,
      ensuringNewSessionRef,
      preset,
      setPreset: (value) => {
        preset = value;
      },
      isActive: () => true,
      captureCommandView: () => () => true,
    });
    return null;
  }
  await act(async () => {
    renderer = create(createElement(Fixture));
  });
  t.after(async () => {
    await act(async () => renderer.unmount());
    if (saved) Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", saved);
    else delete globalThis.IS_REACT_ACT_ENVIRONMENT;
  });
  assert.deepEqual(await current.initialToolNames(), ["read", "bash", "edit", "write"]);
  assert.equal(api.state.requests.length, 0, "the Host resolves the executor when creating the session");
  await act(async () => current.handleToolPresetChange("full"));
  assert.equal(preset, "full");
  const selected = await current.initialToolNames();
  assert.ok(selected.includes("powershell"));
  assert.ok(!selected.includes("bash"));
  await act(async () => current.handleToolPresetChange("none"));
  assert.deepEqual(await current.initialToolNames(), []);
  sessionIdRef.current = "session";
  api.state.tools = api.state.choices;
  await act(async () => current.handleToolPresetChange("none"));
  assert.deepEqual(api.state.requests.at(-1), { id: "session", type: "set_tools", toolNames: [] });
  api.state.failure = true;
  await act(async () => current.handleToolPresetChange("full"));
  assert.deepEqual(await current.initialToolNames(), []);
  assert.match(current.toolSelectionError, /save failed/);
  owner = "second";
  preset = "default";
  sessionIdRef.current = null;
  api.state.choices = [
    { name: "bash", available: true },
    { name: "powershell", available: false },
  ];
  await act(async () => renderer.update(createElement(Fixture)));
  assert.deepEqual(await current.initialToolNames(), ["read", "bash", "edit", "write"]);
});
