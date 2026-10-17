import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { createElement } from "react";
import { act, create } from "react-test-renderer";
import { importTestBundle } from "#test-bundle";
const { AgentShellSetting, api } = await importTestBundle("agent-shell-setting-ui", {
  stdin: {
    resolveDir: import.meta.dirname,
    loader: "tsx",
    contents: 'export {AgentShellSetting} from "./AgentShellSetting.tsx";export * as api from "@/lib/api-client";',
  },
  tsconfig: path.join(import.meta.dirname, "../../../tsconfig.renderer.json"),
  external: ["react"],
  plugins: [
    {
      name: "shell-setting-api",
      setup(build) {
        build.onResolve({ filter: /^@\/lib\/api-client$/ }, () => ({ path: "api", namespace: "shell-setting-test" }));
        build.onLoad({ filter: /.*/, namespace: "shell-setting-test" }, () => ({
          contents:
            'export const state={shell:"powershell",fail:false,calls:[]};export async function call(method,params){state.calls.push({method,params});if(state.fail)throw new Error("failed");if(params)state.shell=params.shell;return {platform:"win32",shell:state.shell};}',
        }));
      },
    },
  ],
});
test("settings offer one persisted shell, explain new-session scope and retain the saved value after failure", async (t) => {
  const before = Object.getOwnPropertyDescriptor(globalThis, "IS_REACT_ACT_ENVIRONMENT");
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const state = {
    platform: "win32",
    capabilities: { "shell.bash": { health: "healthy" }, "shell.powershell": { health: "healthy" } },
  };
  let renderer;
  await act(async () => {
    renderer = create(createElement(AgentShellSetting, { state }));
  });
  t.after(async () => {
    await act(async () => renderer.unmount());
    if (before) Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", before);
    else delete globalThis.IS_REACT_ACT_ENVIRONMENT;
  });
  const select = () => renderer.root.findByType("select");
  assert.equal(select().props.value, "powershell");
  assert.equal(renderer.root.findAllByType("input").length, 0);
  assert.match(JSON.stringify(renderer.toJSON()), /Existing sessions keep their shell/);
  await act(async () => select().props.onChange({ target: { value: "bash" } }));
  assert.equal(select().props.value, "bash");
  assert.deepEqual(api.state.calls.at(-1), { method: "settings.setAgentShell", params: { shell: "bash" } });
  await act(async () => renderer.unmount());
  await act(async () => {
    renderer = create(createElement(AgentShellSetting, { state }));
  });
  assert.equal(select().props.value, "bash");
  api.state.fail = true;
  await act(async () => select().props.onChange({ target: { value: "powershell" } }));
  assert.equal(select().props.value, "bash");
  assert.match(JSON.stringify(renderer.root.findByProps({ role: "alert" }).children), /could not be saved/);
  await act(async () =>
    renderer.update(
      createElement(AgentShellSetting, {
        state: { ...state, capabilities: { ...state.capabilities, "shell.powershell": { health: "missing" } } },
      }),
    ),
  );
  assert.equal(
    renderer.root.findAllByType("option").find((option) => option.props.value === "powershell").props.disabled,
    true,
  );
});
