import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { extractInterfaceProperties } from "../../scripts/check-contract-coverage.mjs";
import path from "node:path";
import test from "node:test";
import { importTestBundle } from "#test-bundle";

const hostRoot = import.meta.dirname;
const stubs = {
  "file-watch":
    "export const createFileWatchService = () => {init('files'); return {};}; export const stopAllFileWatches = () => step('files-stop');",
  "auth-login":
    "export const createAuthLoginService = () => {init('auth'); return {start: unexpected, cancel() {}, dispose() {step('auth-stop');}};}; export const resolveLoginCode = () => false;",
  "channels/channel-manager":
    "export class ChannelManager {constructor() {init('channels');} async initialize() {} shutdown() {return step('channels-stop');}}",
  "managed-process/runtime":
    "export const initializeManagedProcessService = () => {init('processes'); return {stopAll: () => step('processes-stop')};};",
  "herdr/runtime":
    "export const initializeHerdrBridge = () => {init('herdr'); return {subscribeRuntime: () => () => step('herdr-unsubscribe'), shutdown: () => step('herdr-stop')};}; export const clearHerdrBridge = () => step('herdr-clear');",
  "rpc-manager":
    "export const subscribeRunningSessions = listener => {state.running.add(listener); return () => {state.running.delete(listener); step('running-off');};}; export const disposeAllRpcSessions = () => step('sessions-stop'); export const syncDesktopToolsForAllSessions = () => {}; export const syncCacheWarmingForAllSessions = async () => 0; export const getRunningRpcSessionIds = () => []; export const getRpcSession = () => state.agent; export const startRpcSession = unexpected;",
  "model-runtime":
    "export const modelCatalogRefreshCoordinator = {cancelAll: () => step('models-stop')}; export const getSharedModelRuntime = unexpected; export const reloadSharedModelRuntimeConfig = unexpected;",
};
const { registerHandlers, control } = await importTestBundle("host-lifecycle-composition", {
  packages: "external",
  stdin: {
    contents: 'export {registerHandlers} from "./handlers.ts"; export * as control from "fixture:host-lifecycle";',
    resolveDir: hostRoot,
    loader: "ts",
  },
  plugins: [
    {
      name: "host-lifecycle",
      setup(build) {
        build.onResolve({ filter: /^fixture:host-lifecycle$/ }, () => ({ path: "state", namespace: "host-lifecycle" }));
        build.onResolve({ filter: /^\./ }, (args) => {
          const resolved = path.resolve(args.resolveDir, args.path).replace(/\.ts$/, "");
          const name = Object.keys(stubs).find((key) => resolved === path.join(hostRoot, key));
          return name ? { path: name, namespace: "host-lifecycle" } : undefined;
        });
        build.onLoad({ filter: /.*/, namespace: "host-lifecycle" }, ({ path: name }) => ({
          loader: "js",
          contents:
            name === "state"
              ? `
          export const state = {created: [], steps: [], running: new Set(), fail: new Set(), agent: undefined};
          export const init = name => state.created.push(name);
          export const step = name => {state.steps.push(name); if(state.fail.has(name)) throw new Error('fixture ' + name);};
          export const unexpected = () => {throw new Error('Unexpected service operation');};
          export function reset() {state.created.length = state.steps.length = 0; state.running.clear(); state.fail.clear(); state.agent = undefined;}
        `
              : 'import {state, init, step, unexpected} from "fixture:host-lifecycle";\n' + stubs[name],
        }));
      },
    },
  ],
});

test("the actual registrar owns one service set and releases subscriptions and services exactly once", async () => {
  control.reset();
  const events = [],
    methods = {};
  let eventListener, destroyListener;
  control.state.agent = {
    sessionId: "fixture",
    isAlive: () => true,
    send: async () => ({}),
    onEvent(listener) {
      eventListener = listener;
      return () => control.step("events-off");
    },
    onDestroy(listener) {
      destroyListener = listener;
      return () => control.step("destroy-off");
    },
  };
  const stop = registerHandlers({
    handle: (next) => Object.assign(methods, next),
    emit: (...args) => events.push(args),
  });
  assert.deepEqual(control.state.created, ["files", "auth", "channels", "processes", "herdr"]);
  const expected = extractInterfaceProperties(
    "api.ts",
    readFileSync(path.join(hostRoot, "../contract/api.ts"), "utf8"),
    "Api",
  );
  assert.deepEqual(Object.keys(methods).sort(), expected.sort());
  assert.equal(control.state.running.size, 1);
  await methods["agent.command"]({ sessionId: "fixture", command: { type: "get_state" } });
  const running = [...control.state.running][0];
  running(["fixture"]);
  eventListener({ type: "agent_start" });
  const before = events.length;
  const first = stop();
  assert.equal(stop(), first);
  assert.throws(
    () => methods["host.ping"](),
    (error) => error.code === "CLOSED",
  );
  assert.throws(
    () => methods["agent.command"]({ sessionId: "fixture", command: { type: "get_state" } }),
    (error) => error.code === "CLOSED",
  );
  await first;
  running(["late"]);
  eventListener({ type: "late" });
  destroyListener();
  assert.equal(events.length, before);
  assert.equal(control.state.running.size, 0);
  assert.deepEqual(control.state.steps, [
    "running-off",
    "events-off",
    "destroy-off",
    "auth-stop",
    "models-stop",
    "herdr-unsubscribe",
    "herdr-stop",
    "herdr-clear",
    "processes-stop",
    "channels-stop",
    "files-stop",
    "sessions-stop",
  ]);
});

test("the actual registrar continues cleanup after a service failure and reports rejection", async () => {
  control.reset();
  control.state.fail.add("herdr-stop");
  const stop = registerHandlers({ handle() {}, emit() {} });
  await assert.rejects(stop(), (error) => error instanceof AggregateError && error.message.includes("Herdr"));
  assert.ok(control.state.steps.indexOf("herdr-clear") > control.state.steps.indexOf("herdr-stop"));
  assert.ok(control.state.steps.includes("processes-stop"));
  assert.ok(control.state.steps.includes("files-stop"));
  assert.ok(control.state.steps.includes("sessions-stop"));
  assert.equal(control.state.running.size, 0);
});
