import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { act, create } from "react-test-renderer";
import { importTestBundle } from "#test-bundle";
import { createDeferred } from "#test-timing";

const { ExecutionHistory, ExecutionNode, api } = await importTestBundle("execution-history-ui", {
  stdin: {
    contents:
      'export {ExecutionHistory, ExecutionNode} from "./ExecutionHistory.tsx"; export * as api from "@/lib/api-client";',
    resolveDir: import.meta.dirname,
    loader: "tsx",
  },
  tsconfig: path.join(import.meta.dirname, "../../../tsconfig.renderer.json"),
  external: ["react", "react-dom", "react-dom/*", "react-test-renderer"],
  plugins: [
    {
      name: "controlled-history",
      setup(build) {
        build.onResolve({ filter: /^@\/lib\/api-client$/ }, () => ({ path: "api", namespace: "execution-test" }));
        build.onLoad({ filter: /.*/, namespace: "execution-test" }, () => ({
          loader: "js",
          contents: `
      export const calls = [], subscriptions = [];
      let response = async () => ({records: [], complete: true, truncatedTail: false});
      export function setResponse(value) { response = value; calls.length = 0; }
      export async function call(method, params) { calls.push({method, params}); return response(method, params); }
      export async function subscribe(topic, key, on) { const item={topic,key,on,closed:false}; subscriptions.push(item); return () => {item.closed=true;}; }
    `,
        }));
      },
    },
  ],
});
const record = (id, status = "succeeded") => ({
  executionId: id,
  runId: "run",
  toolCallId: id,
  rootToolCallId: id,
  sequence: 1,
  source: "local",
  toolName: id,
  status,
  requestedAt: 1,
  arguments: { preview: "original arguments", complete: true },
});

test("execution UI shows independent parent/child states, unknown outcomes and original content access", () => {
  const html = renderToStaticMarkup(
    createElement(ExecutionNode, {
      sessionId: "fixture",
      node: {
        record: record("parent", "failed"),
        children: [{ record: { ...record("child", "interrupted"), outcomeUnknown: true }, children: [] }],
      },
    }),
  );
  assert.match(html, /data-execution-status="failed"/);
  assert.match(html, /data-execution-status="interrupted"/);
  assert.match(html, /actual outcome is unknown/);
  assert.match(html, /Read original content/);
});

test("switching the session rejects stale history and releases both stream subscriptions", async (t) => {
  const previous = globalThis.IS_REACT_ACT_ENVIRONMENT;
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const deferred = createDeferred();
  api.setResponse((_method, params) =>
    params.id === "old" ? deferred.promise : { records: [record("new-result")], complete: true, truncatedTail: false },
  );
  let renderer;
  t.after(async () => {
    if (renderer) await act(async () => renderer.unmount());
    globalThis.IS_REACT_ACT_ENVIRONMENT = previous;
  });
  await act(async () => {
    renderer = create(createElement(ExecutionHistory, { sessionId: "old" }));
  });
  await act(async () => {
    renderer.update(createElement(ExecutionHistory, { sessionId: "new", leafId: "new-branch" }));
  });
  await act(async () => {
    deferred.resolve({ records: [record("stale-result")], complete: true, truncatedTail: false });
  });
  assert.match(JSON.stringify(renderer.toJSON()), /new-result/);
  assert.doesNotMatch(JSON.stringify(renderer.toJSON()), /stale-result/);
  assert.equal(api.calls.find((call) => call.params.id === "new").params.leafId, "new-branch");
  assert.equal(
    api.subscriptions.filter((item) => item.key === "old").every((item) => item.closed),
    true,
  );
});

test("an unsaved empty session does not display a false history failure", async (t) => {
  const previous = globalThis.IS_REACT_ACT_ENVIRONMENT;
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  api.setResponse(async () => {
    throw Object.assign(new Error("Session not yet persisted"), { code: "NOT_FOUND" });
  });
  let renderer;
  t.after(async () => {
    if (renderer) await act(async () => renderer.unmount());
    globalThis.IS_REACT_ACT_ENVIRONMENT = previous;
  });
  await act(async () => {
    renderer = create(createElement(ExecutionHistory, { sessionId: "empty" }));
  });
  assert.doesNotMatch(JSON.stringify(renderer.toJSON()), /Could not read execution history|data-execution-history/);
  assert.match(JSON.stringify(renderer.toJSON()), /Open MCP settings/);
});
