import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { createElement } from "react";
import { act, create } from "react-test-renderer";
import { createDeferred } from "#test-timing";
import { importTestBundle } from "#test-bundle";
const { useSessionToolSelection, api } = await importTestBundle("tool-selection-review", {
  stdin: {
    resolveDir: import.meta.dirname,
    loader: "ts",
    contents:
      'export {useSessionToolSelection} from "./useSessionToolSelection.ts";export * as api from "@/lib/api-client";',
  },
  tsconfig: path.join(import.meta.dirname, "../../../tsconfig.renderer.json"),
  external: ["react"],
  plugins: [
    {
      name: "tool-review-api",
      setup(build) {
        build.onResolve({ filter: /^@\/lib\/(?:api-client|agent-client)$/ }, () => ({
          path: "api",
          namespace: "tool-review",
        }));
        build.onLoad({ filter: /.*/, namespace: "tool-review" }, () => ({
          contents: `
      export const state={tools:[],requests:[],capabilitiesHold:null,readHold:null,beforeReply:null};
      export const call=async()=>{if(state.capabilitiesHold)await state.capabilitiesHold;return {codingTools:state.tools};};
      export const sendAgentCommand=async(id,command)=>{state.requests.push({id,...command});
        if(command.type==='get_tools'){const snapshot=structuredClone(state.tools);if(state.readHold)await state.readHold;return snapshot;}
        await state.beforeReply?.(command);return null;};`,
        }));
      },
    },
  ],
});
async function fixture(t, sessionId = "session") {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "IS_REACT_ACT_ENVIRONMENT");
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  api.state.tools = ["powershell", "bash"].map((name) => ({
    name,
    description: name,
    active: true,
    available: true,
    executionAllowed: true,
  }));
  api.state.requests = [];
  api.state.capabilitiesHold = api.state.readHold = api.state.beforeReply = null;
  let current,
    preset = "default",
    renderer;
  function Fixture() {
    current = useSessionToolSelection({
      cwd: "/workspace",
      owner: "fixture",
      sessionIdRef: { current: sessionId },
      ensuringNewSessionRef: { current: null },
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
    if (previous) Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", previous);
    else delete globalThis.IS_REACT_ACT_ENVIRONMENT;
  });
  return {
    get preset() {
      return preset;
    },
    get current() {
      return current;
    },
  };
}

test("a late full-preset capability result cannot override a newer no-tools choice", async (t) => {
  const f = await fixture(t, null),
    hold = createDeferred();
  t.after(() => hold.resolve());
  await act(async () => f.current.handleToolPresetChange("none"));
  api.state.capabilitiesHold = hold.promise;
  let full;
  await act(async () => {
    full = f.current.handleToolPresetChange("full");
  });
  await act(async () => f.current.handleToolPresetChange("none"));
  await act(async () => {
    hold.resolve();
    await full;
  });
  assert.deepEqual(await f.current.initialToolNames(), []);
});

test("loading session tools reconciles the preset with current authorized tools", async (t) => {
  const f = await fixture(t);
  await act(async () => f.current.handleToolPresetChange("none"));
  api.state.tools = api.state.tools.filter((tool) => tool.name === "powershell");
  await act(async () => f.current.loadTools("session"));
  assert.equal(f.preset, "custom");
  assert.deepEqual(await f.current.initialToolNames(), ["powershell"]);
});

test("a delayed permission grant cannot overwrite a later revocation", async (t) => {
  const f = await fixture(t),
    hold = createDeferred();
  t.after(() => hold.resolve());
  await act(async () => f.current.loadTools("session"));
  assert.deepEqual(await f.current.initialToolNames(), ["powershell", "bash"]);
  api.state.beforeReply = (command) => (command.toolNames.length ? hold.promise : undefined);
  let first;
  await act(async () => {
    first = f.current.handleToolPresetChange("full");
  });
  await act(async () => f.current.handleToolPresetChange("none"));
  assert.deepEqual(api.state.requests.at(-1).toolNames, [], "revocation must remove every command executor");
  await act(async () => {
    hold.resolve();
    await first;
  });
  assert.deepEqual(await f.current.initialToolNames(), []);
});

test("a late shell snapshot cannot restore grants revoked while it was loading", async (t) => {
  const f = await fixture(t),
    hold = createDeferred();
  t.after(() => hold.resolve());
  api.state.readHold = hold.promise;
  let reading;
  await act(async () => {
    reading = f.current.loadTools("session");
  });
  await act(async () => f.current.handleToolPresetChange("none"));
  await act(async () => {
    hold.resolve();
    await reading;
  });
  assert.deepEqual(await f.current.initialToolNames(), []);
});

test("SDK-only PowerShell activation is not carried into the saved session selection", async (t) => {
  const f = await fixture(t);
  api.state.tools = api.state.tools.map((tool) => ({ ...tool, executionAllowed: tool.name !== "powershell" }));
  await act(async () => f.current.loadTools("session"));
  assert.deepEqual(await f.current.initialToolNames(), ["bash"]);
  await act(async () => f.current.handleToolPresetChange("none"));
  assert.deepEqual(api.state.requests.at(-1).toolNames, []);
});
