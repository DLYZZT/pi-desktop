import assert from "node:assert/strict";
import test from "node:test";
import { importTestBundle } from "#test-bundle";
import { createDeferred } from "#test-timing";

const { ApiEventSource, testApi } = await importTestBundle("api-event-source-routing", {
  stdin: {
    contents: 'export { ApiEventSource } from "./api-fetch.ts"; export * as testApi from "./api-client";',
    resolveDir: import.meta.dirname,
    loader: "ts",
  },
  plugins: [
    {
      name: "event-source-fixture",
      setup(build) {
        build.onResolve({ filter: /^\.\/api-client$/ }, () => ({ path: "api-client", namespace: "event-source-test" }));
        build.onLoad({ filter: /.*/, namespace: "event-source-test" }, () => ({
          contents: `
        export const subscriptions = [];
        let installation;
        export function reset(next) {subscriptions.length = 0; installation = next;}
        async function install(topic, key, on) {
          const entry = {topic, key, on, released: 0}; subscriptions.push(entry);
          if(installation) await installation;
          return () => entry.released++;
        }
        export const subscribeAgentEvents = (key, on) => install('agent.events', key, on);
        export const subscribeRunning = on => install('agent.running', '*', on);
        export const subscribeAuthLogin = (key, on) => install('auth.login', key, on);
        export const subscribe = install;
        const unexpected = () => { throw new Error('Unexpected API call'); };
        export const agentCommand = unexpected, agentState = unexpected, call = unexpected,
          deleteSession = unexpected, exportSession = unexpected, fileIndex = unexpected,
          fileMeta = unexpected, getHome = unexpected, getSession = unexpected,
          getSessionContext = unexpected, listFiles = unexpected, listModels = unexpected,
          listSessions = unexpected, listWorktrees = unexpected, newAgent = unexpected,
          readFile = unexpected, renameSession = unexpected, validateCwd = unexpected, defaultCwd = unexpected;
      `,
        }));
      },
    },
  ],
});

const settle = () => new Promise((resolve) => setImmediate(resolve));

test("running EventSource uses the wildcard running stream and delivers status frames", async (t) => {
  testApi.reset();
  const source = new ApiEventSource("/api/agent/running/events");
  t.after(() => source.close());
  const messages = [];
  source.onmessage = (event) => messages.push(JSON.parse(event.data));
  await settle();
  assert.equal(testApi.subscriptions.length, 1);
  assert.equal(testApi.subscriptions[0].topic, "agent.running");
  assert.equal(testApi.subscriptions[0].key, "*");
  const status = { type: "running", sessionIds: ["owner"] };
  testApi.subscriptions[0].on(status);
  assert.deepEqual(messages, [status]);
  source.close();
  testApi.subscriptions[0].on({ type: "running", sessionIds: [] });
  assert.deepEqual(messages, [status]);
  assert.equal(testApi.subscriptions[0].released, 1);
});

test("individual agent events keep their decoded session key and connected notification", async (t) => {
  testApi.reset();
  const source = new ApiEventSource("/api/agent/owner%20one/events");
  t.after(() => source.close());
  const messages = [];
  source.onmessage = (event) => messages.push(JSON.parse(event.data));
  await settle();
  assert.equal(testApi.subscriptions[0].topic, "agent.events");
  assert.equal(testApi.subscriptions[0].key, "owner one");
  assert.deepEqual(messages, [{ type: "connected" }]);
  testApi.subscriptions[0].on({ type: "agent_end" });
  assert.deepEqual(messages.at(-1), { type: "agent_end" });
});

test("a running stream installed after close is released without delivering late frames", async () => {
  const installation = createDeferred();
  testApi.reset(installation.promise);
  const source = new ApiEventSource("/api/agent/running/events");
  let delivered = 0;
  source.onmessage = () => delivered++;
  source.close();
  installation.resolve();
  await settle();
  testApi.subscriptions[0].on({ type: "running", sessionIds: ["late"] });
  assert.equal(testApi.subscriptions[0].released, 1);
  assert.equal(source.readyState, ApiEventSource.CLOSED);
  assert.equal(delivered, 0);
});
