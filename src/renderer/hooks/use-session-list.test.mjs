import assert from "node:assert/strict";
import path from "node:path";
import test, { after } from "node:test";
import { createElement } from "react";
import { act, create } from "react-test-renderer";
import { importTestBundle } from "#test-bundle";
import { createDeferred } from "#test-timing";

const previousActEnvironment = globalThis.IS_REACT_ACT_ENVIRONMENT;
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
after(() => {
  if (previousActEnvironment === undefined) delete globalThis.IS_REACT_ACT_ENVIRONMENT;
  else globalThis.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment;
});

const { useSessionList, SessionSidebar, testApi } = await importTestBundle("session-list-hook", {
  stdin: {
    contents:
      'export {useSessionList} from "./useSessionList.ts"; export {SessionSidebar} from "../components/SessionSidebar.tsx"; export * as testApi from "@/lib/api-client";',
    resolveDir: import.meta.dirname,
    loader: "ts",
  },
  tsconfig: path.join(import.meta.dirname, "../../../tsconfig.renderer.json"),
  external: ["react", "react-dom", "react-dom/*"],
  plugins: [
    {
      name: "session-list-fixture",
      setup(build) {
        build.onResolve({ filter: /^@\/(i18n|lib\/api-client)$/ }, ({ path }) => ({ path, namespace: "list-test" }));
        build.onLoad({ filter: /.*/, namespace: "list-test" }, ({ path }) => ({
          loader: "js",
          contents:
            path === "@/i18n"
              ? `
        const t = (_key, fallback) => fallback;
        export function useI18n() { return {t, language: 'en'}; }
      `
              : `
        export const subscriptions = [];
        let installation;
        export function reset(next) {subscriptions.length = 0; installation = next;}
        export async function subscribeSessionsChanged(on) {
          const entry = {on, closed: 0}; subscriptions.push(entry);
          if(installation) await installation;
          return () => entry.closed++;
        }
        export async function call(method, params) {
          if(method !== 'worktrees.list') throw new Error('Unexpected RPC: '+method);
          return {projectRoot: params.projectRoot, isGit: false, isTopLevel: true, worktrees: []};
        }
      `,
        }));
      },
    },
  ],
});

const session = (id, name = id) => ({
  id,
  name,
  cwd: "/project",
  projectRoot: "/project",
  path: `/${id}`,
  created: "2026-09-26T00:00:00Z",
  modified: "2026-09-26T00:00:00Z",
  messageCount: 1,
  firstMessage: name,
});
const response = (sessions, runningSessionIds = []) =>
  new globalThis.Response(JSON.stringify({ sessions, runningSessionIds }));

async function mount(t, { sidebar = false, installation, storedUnread = [] } = {}) {
  testApi.reset(installation);
  const previous = new Map(
    ["window", "document", "EventSource"].map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]),
  );
  const storage = new Map(storedUnread.length ? [["pi-desktop:unread-session-ids", JSON.stringify(storedUnread)]] : []);
  const sources = [];
  globalThis.window = {
    localStorage: {
      getItem: (key) => storage.get(key) ?? null,
      setItem: (key, value) => storage.set(key, value),
      removeItem: (key) => storage.delete(key),
    },
  };
  globalThis.document = { addEventListener() {}, removeEventListener() {} };
  globalThis.EventSource = class {
    constructor(url) {
      this.url = url;
      this.closed = false;
      sources.push(this);
    }
    close() {
      this.closed = true;
    }
  };
  const requests = [];
  t.mock.method(globalThis, "fetch", async (url) => {
    if (url === "/api/home") return new globalThis.Response(JSON.stringify({ home: "/fixture" }));
    assert.equal(url, "/api/sessions");
    const request = createDeferred();
    requests.push(request);
    return request.promise;
  });
  let current, renderer;
  const deleted = [];
  const onSessionDeleted = (id) => deleted.push(id);
  const onSelectSession = () => {};
  function Probe() {
    current = useSessionList();
    return sidebar
      ? createElement(SessionSidebar, {
          sessionList: current,
          selectedSessionId: null,
          selectedCwd: "/project",
          onSelectSession,
          onSessionDeleted,
        })
      : null;
  }
  const unmount = async () => {
    if (renderer) await act(async () => renderer.unmount());
    renderer = null;
  };
  t.after(async () => {
    await unmount();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  });
  await act(async () => {
    renderer = create(createElement(Probe));
  });
  return {
    get current() {
      return current;
    },
    get renderer() {
      return renderer;
    },
    requests,
    sources,
    deleted,
    storage,
    unmount,
    async reply(index, value) {
      await act(async () => requests[index].resolve(value));
    },
    async change(event) {
      await act(async () => testApi.subscriptions[0].on(event));
    },
  };
}

test("one mounted catalog serves sidebar updates and metadata without duplicating list requests", async (t) => {
  const fixture = await mount(t, { sidebar: true });
  assert.equal(fixture.requests.length, 1);
  assert.equal(testApi.subscriptions.length, 1);
  await fixture.reply(0, response([session("one")]));
  await fixture.change({ cwd: "/project", session: session("one", "Renamed") });
  assert.deepEqual(await fixture.current.findSession("one"), session("one", "Renamed"));
  assert.equal(
    fixture.renderer.root.findAll((node) => node.props["aria-label"] === "Session actions for Renamed").length,
    1,
  );
  assert.equal(fixture.requests.length, 1);
  await fixture.change({ cwd: "/project", sessionId: "one", deleted: true });
  await fixture.change({ cwd: "/project", sessionId: "one", deleted: true });
  assert.deepEqual(fixture.deleted, ["one"]);
  assert.equal(
    fixture.renderer.root.findAll((node) => node.props["aria-label"] === "Session actions for Renamed").length,
    0,
  );
  await fixture.unmount();
  assert.equal(testApi.subscriptions[0].closed, 1);
  assert.equal(fixture.sources[0].closed, true);
});

test("live running status keeps precedence over a late list fallback", async (t) => {
  const fixture = await mount(t, { sidebar: true });
  await act(async () =>
    fixture.sources[0].onmessage({ data: JSON.stringify({ type: "running", sessionIds: ["one"] }) }),
  );
  await fixture.reply(0, response([session("one")], []));
  assert.equal(fixture.renderer.root.findAll((node) => node.props["aria-label"] === "Agent running").length, 1);
  await act(async () => fixture.sources[0].onmessage({ data: JSON.stringify({ type: "running", sessionIds: [] }) }));
  assert.equal(fixture.renderer.root.findAll((node) => node.props["aria-label"] === "Agent running").length, 0);
  assert.equal(fixture.requests.length, 1);
});

test("failed initial loading preserves unread markers and manual retry restores the list", async (t) => {
  const fixture = await mount(t, { sidebar: true, storedUnread: ["one"] });
  await fixture.reply(0, new globalThis.Response(JSON.stringify({ error: "offline" }), { status: 401 }));
  assert.deepEqual(JSON.parse(fixture.storage.get("pi-desktop:unread-session-ids")), ["one"]);
  assert.match(JSON.stringify(fixture.renderer.toJSON()), /Unauthorized \(401\)/);
  const refresh = fixture.renderer.root.find((node) => node.type === "button" && node.props.title === "Refresh");
  await act(async () => {
    void refresh.props.onClick();
  });
  assert.equal(fixture.requests.length, 2);
  await fixture.reply(1, response([session("one")]));
  assert.equal(fixture.current.getSnapshot().error, null);
  assert.equal(fixture.current.getSnapshot().loading, false);
});

test("subscription failure still loads sessions and keeps committed-operation fallback available", async (t) => {
  const installation = createDeferred();
  const fixture = await mount(t, { installation: installation.promise });
  assert.equal(fixture.requests.length, 0);
  await act(async () => installation.reject(new Error("Unavailable stream")));
  assert.equal(fixture.requests.length, 1);
  await fixture.reply(0, response([session("one")]));
  assert.equal(fixture.current.getSnapshot().live, false);
  await act(async () => fixture.current.refreshIfDisconnected());
  assert.equal(fixture.requests.length, 2);
  await fixture.reply(1, response([session("one", "Updated")]));
});

test("unmount releases a subscription installed late and prevents it from starting a list read", async (t) => {
  const installation = createDeferred();
  const fixture = await mount(t, { installation: installation.promise });
  const snapshot = fixture.current.getSnapshot();
  await fixture.unmount();
  await act(async () => installation.resolve());
  assert.equal(testApi.subscriptions[0].closed, 1);
  testApi.subscriptions[0].on({ cwd: "/project", session: session("late") });
  assert.equal(fixture.current.getSnapshot(), snapshot);
  assert.equal(fixture.requests.length, 0);
});
