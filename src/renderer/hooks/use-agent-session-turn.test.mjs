import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { createElement } from "react";
import { act, create } from "react-test-renderer";
import { importTestBundle } from "#test-bundle";

const { useAgentSession } = await importTestBundle("session-turn-hook", {
  entryPoints: [path.join(import.meta.dirname, "useAgentSession.ts")],
  tsconfig: path.join(import.meta.dirname, "../../../tsconfig.renderer.json"),
  external: ["react", "react-dom", "react-dom/*"],
  plugins: [
    {
      name: "offline-session-turn",
      setup(build) {
        build.onResolve({ filter: /^@\/(i18n|lib\/(api-client|agent-client))$/ }, ({ path }) => ({
          path,
          namespace: "session-turn-test",
        }));
        build.onLoad({ filter: /.*/, namespace: "session-turn-test" }, ({ path }) => ({
          loader: "js",
          contents:
            path === "@/i18n"
              ? `
          const t = (_key, fallback) => fallback;
          export function useI18n() { return { language: "en-US", t }; }
        `
              : path === "@/lib/agent-client"
                ? `
          export async function sendAgentCommand() { throw new Error("unexpected command"); }
        `
                : `
          export async function listModels() { return { models: [], catalog: { source: "cache", refreshed: false, aborted: false, warnings: [] } }; }
          export async function agentState() { return { running: false }; }
          export async function subscribeAgentEvents() { return () => {}; }
          export async function subscribeSessionsChanged() { return () => {}; }
          const unexpected = async () => { throw new Error("unexpected session IO"); };
          export { unexpected as getSession, unexpected as getSessionContext, unexpected as getSessionContextPage,
            unexpected as getSessionEntryContent, unexpected as newAgent, unexpected as refreshModels,
            unexpected as cancelModelsRefresh };
        `,
        }));
      },
    },
  ],
});

test("the session hook renders turn events and settles a multi-run prompt exactly once", async (t) => {
  const originals = new Map();
  const install = (name, value) => {
    originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  };
  install("IS_REACT_ACT_ENVIRONMENT", true);
  install("window", { addEventListener() {}, removeEventListener() {} });
  install("document", { visibilityState: "visible", addEventListener() {}, removeEventListener() {} });
  install("requestAnimationFrame", (callback) => {
    callback();
    return 0;
  });
  install("cancelAnimationFrame", () => {});
  let renderer;
  t.after(async () => {
    if (renderer) await act(async () => renderer.unmount());
    for (const [name, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete globalThis[name];
    }
  });
  let current;
  let completions = 0;
  const options = { session: null, newSessionCwd: null, onAgentEnd: () => completions++ };
  function Probe() {
    current = useAgentSession(options);
    return createElement("output", null, current.agentRunning ? "running" : "idle");
  }
  await act(async () => {
    renderer = create(createElement(Probe));
  });
  const emit = async (event) => act(async () => current.handleAgentEventRef.current(event));
  const message = { role: "assistant", content: [{ type: "text", text: "streamed reply" }] };

  await emit({ type: "agent_start" });
  assert.deepEqual(renderer.toJSON().children, ["running"]);
  await emit({ type: "message_update", message });
  assert.deepEqual(current.streamState.streamingMessage, message);
  await emit({ type: "message_end", message });
  assert.equal(current.messages.length, 1);
  assert.equal(current.streamState.streamingMessage, null);
  await emit({ type: "agent_end" });
  assert.equal(current.agentRunning, true, "an SDK boundary is not Desktop prompt settlement");
  assert.equal(completions, 0);

  await emit({ type: "queue_update", steering: ["steer"], followUp: ["later"] });
  assert.deepEqual(current.queuedMessages, { steering: ["steer"], followUp: ["later"] });
  await emit({ type: "auto_retry_start", attempt: 1, maxAttempts: 3 });
  assert.equal(current.retryInfo.attempt, 1);
  await emit({ type: "compaction_start" });
  assert.equal(current.isCompacting, true);
  await emit({ type: "compaction_end", aborted: true });
  assert.equal(current.isCompacting, false);

  await emit({ type: "prompt_done" });
  await emit({ type: "prompt_done" });
  assert.deepEqual(renderer.toJSON().children, ["idle"]);
  assert.equal(current.retryInfo, null);
  assert.equal(completions, 1);
  await emit({ type: "message_update", message });
  await emit({ type: "message_end", message });
  assert.equal(current.streamState.streamingMessage, null);
  assert.equal(current.messages.length, 1, "late completion does not append the persisted message again");
});
