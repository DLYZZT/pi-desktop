import assert from "node:assert/strict";
import test from "node:test";
import { importTestBundle } from "#test-bundle";

const { apiFetch, ApiEventSource, testApi } = await importTestBundle("api-event-source-routing", {
  stdin: {
    contents: 'export { apiFetch, ApiEventSource } from "./api-fetch.ts"; export * as testApi from "./api-client";',
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
        export let unexpectedCalls = 0;
        export function reset(next) {subscriptions.length = 0; unexpectedCalls = 0; installation = next;}
        async function install(topic, key, on) {
          const entry = {topic, key, on, released: 0}; subscriptions.push(entry);
          if(installation) await installation;
          return () => entry.released++;
        }
        export const subscribeAgentEvents = (key, on) => install('agent.events', key, on);
        export const subscribeRunning = on => install('agent.running', '*', on);
        export const subscribeAuthLogin = (key, on) => install('auth.login', key, on);
        export const subscribe = install;
        const unexpected = () => { unexpectedCalls++; throw new Error('Unexpected API call'); };
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

test("migrated skills and plugins routes cannot silently re-enter the compatibility adapter", async () => {
  testApi.reset();
  for (const [route, method] of [
    ["/api/skills?cwd=/fixture", "GET"],
    ["/api/skills", "PATCH"],
    ["/api/skills/search", "POST"],
    ["/api/skills/install", "POST"],
    ["/api/plugins?cwd=/fixture", "GET"],
    ["/api/plugins", "POST"],
  ]) {
    const response = await apiFetch(route, {
      method,
      body: JSON.stringify({ cwd: "/fixture", action: "install", source: "fixture", package: "fixture" }),
    });
    assert.equal(response.status, 404);
  }
  assert.equal(testApi.unexpectedCalls, 0);
});

test("model and auth operations no longer start through legacy routes or EventSource", async () => {
  testApi.reset();
  for (const [route, method] of [
    ["/api/models-config", "GET"],
    ["/api/models-config", "PUT"],
    ["/api/models-config/test", "POST"],
    ["/api/auth/providers", "GET"],
    ["/api/auth/all-providers", "GET"],
    ["/api/auth/logout/fixture", "POST"],
    ["/api/auth/api-key/fixture", "POST"],
    ["/api/auth/api-key/fixture", "DELETE"],
    ["/api/auth/login/fixture", "POST"],
  ]) {
    const response = await apiFetch(route, {
      method,
      body: JSON.stringify({ provider: "fixture", config: {}, expectedVersion: "one" }),
    });
    assert.equal(response.status, 404);
  }
  const source = new ApiEventSource("/api/auth/login/fixture");
  await settle();
  assert.equal(source.readyState, ApiEventSource.CLOSED);
  assert.equal(testApi.subscriptions.length, 0);
  assert.equal(testApi.unexpectedCalls, 0);
});

test("session, agent, model, workspace and system routes stay retired", async () => {
  testApi.reset();
  for (const [route, method] of [
    ["/api/sessions", "GET"],
    ["/api/sessions/one", "GET"],
    ["/api/sessions/one", "PATCH"],
    ["/api/sessions/one", "DELETE"],
    ["/api/sessions/one/context", "GET"],
    ["/api/agent/new", "POST"],
    ["/api/agent/one", "GET"],
    ["/api/agent/one", "POST"],
    ["/api/models", "GET"],
    ["/api/models/refresh", "POST"],
    ["/api/models/refresh", "DELETE"],
    ["/api/worktrees", "GET"],
    ["/api/worktrees", "POST"],
    ["/api/worktrees", "DELETE"],
    ["/api/cwd/validate", "POST"],
    ["/api/default-cwd", "POST"],
    ["/api/home", "GET"],
  ]) {
    const response = await apiFetch(route, {
      method,
      body: JSON.stringify({ name: "fixture", path: "/fixture", cwd: "/fixture" }),
    });
    assert.equal(response.status, 404, `${method} ${route}`);
  }
  for (const route of ["/api/agent/running/events", "/api/agent/one/events"]) {
    const stream = new ApiEventSource(route);
    await settle();
    assert.equal(stream.readyState, ApiEventSource.CLOSED);
  }
  assert.equal(testApi.subscriptions.length, 0);
  assert.equal(testApi.unexpectedCalls, 0);
});
