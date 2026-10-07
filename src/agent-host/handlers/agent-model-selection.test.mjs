import assert from "node:assert/strict";
import test from "node:test";
import { importTestBundle } from "#test-bundle";
const { createAgentHandlers, fixture } = await importTestBundle("agent-model-choice", {
  packages: "external",
  stdin: {
    resolveDir: import.meta.dirname,
    loader: "ts",
    contents: 'export {createAgentHandlers} from "./agent.ts"; export * as fixture from "../rpc-manager";',
  },
  plugins: [
    {
      name: "model-choice-fixture",
      setup(build) {
        build.onResolve(
          { filter: /^\.\.\/(rpc-manager|session-reader|session-readonly|file-access|session-change)$/ },
          (args) => ({ path: args.path, namespace: "model-choice" }),
        );
        build.onLoad({ filter: /.*/, namespace: "model-choice" }, ({ path: module }) => ({
          loader: "js",
          contents: module.endsWith("rpc-manager")
            ? `
      export const calls=[];let blocked=true;export function configure(value){blocked=value;calls.length=0;}
      const session={inner:{},modelSelection:{snapshot:()=>blocked?{requiresChoice:true}:undefined},send:async command=>{calls.push(command);return null;}};
      export function getRpcSession(){return session;} export async function startRpcSession(){return{session,realSessionId:'fixture'};}
    `
            : module.endsWith("session-reader")
              ? "export async function resolveSessionPath(){return undefined;}"
              : module.endsWith("session-readonly")
                ? 'export function readSessionSnapshot(){throw new Error("not used");}'
                : module.endsWith("file-access")
                  ? "export function allowFileRoot(){}"
                  : "export async function emitIndexedSessionChange(){}",
        }));
      },
    },
  ],
});
const handlers = createAgentHandlers({ server: { emit() {} }, bindEvents() {} });
test("an automatically displayed default cannot dismiss a model restore warning", async () => {
  fixture.configure(true);
  await handlers.new({
    cwd: process.cwd(),
    type: "ensure_session",
    provider: "replacement",
    modelId: "model",
    modelSelectionExplicit: false,
  });
  assert.deepEqual(fixture.calls, []);
  await handlers.new({
    cwd: process.cwd(),
    type: "ensure_session",
    provider: "replacement",
    modelId: "model",
    modelSelectionExplicit: true,
  });
  assert.deepEqual(fixture.calls, [{ type: "set_model", provider: "replacement", modelId: "model" }]);
});
test("ordinary defaults and explicitly supplied API model choices keep their existing behavior", async () => {
  fixture.configure(false);
  await handlers.new({
    cwd: process.cwd(),
    type: "ensure_session",
    provider: "default",
    modelId: "model",
    modelSelectionExplicit: false,
  });
  assert.equal(fixture.calls.length, 1);
  fixture.configure(true);
  await handlers.new({ cwd: process.cwd(), type: "ensure_session", provider: "explicit-api", modelId: "model" });
  assert.equal(fixture.calls.length, 1);
  await assert.rejects(
    handlers.new({ cwd: process.cwd(), modelSelectionExplicit: "false" }),
    (error) => error.code === "BAD_REQUEST",
  );
});
