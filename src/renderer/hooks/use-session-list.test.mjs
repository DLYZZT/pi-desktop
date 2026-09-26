import assert from "node:assert/strict";
import path from "node:path";
import test, { after } from "node:test";
import { createElement } from "react";
import { act, create } from "react-test-renderer";
import { importTestBundle } from "#test-bundle";
import { RpcError } from "../../contract/types.ts";
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
        export const subscriptions = [], running = [], lists = [], requests = [];
        let installation, runningInstallation;
        export function reset(next, runningNext) {subscriptions.length = running.length = lists.length = requests.length = 0; installation = next; runningInstallation = runningNext;}
        function pending(list, method, params) {let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});list.push({method,params,resolve,reject});return promise;}
        export function listSessions() {return pending(lists, 'sessions.list');}
        export async function subscribeRunning(on) {const entry={on,closed:0};running.push(entry);if(runningInstallation) await runningInstallation;return()=>entry.closed++;}
        export async function subscribeSessionsChanged(on) {
          const entry = {on, closed: 0}; subscriptions.push(entry);
          if(installation) await installation;
          return () => entry.closed++;
        }
        export async function call(method, params) {
          if(method === 'system.home') return {home:'/fixture'};
          if(method === 'worktrees.list') return {projectRoot: params.projectRoot, isGit: false, isTopLevel: true, worktrees: []};
          return pending(requests,method,params);
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
const response = (sessions, runningSessionIds = []) => ({ sessions, runningSessionIds });

async function mount(t, { sidebar = false, installation, runningInstallation, storedUnread = [] } = {}) {
  testApi.reset(installation, runningInstallation);
  const previous = new Map(
    ["window", "document", "EventSource"].map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]),
  );
  const storage = new Map(storedUnread.length ? [["pi-desktop:unread-session-ids", JSON.stringify(storedUnread)]] : []);
  const sources = testApi.running,
    requests = testApi.lists,
    mutations = testApi.requests;
  const alerts = [],
    selectedDirectories = [],
    directoryChoices = [];
  globalThis.window = {
    alert: (message) => alerts.push(message),
    requestAnimationFrame: (callback) => setTimeout(callback, 0),
    cancelAnimationFrame: (timer) => clearTimeout(timer),
    piBridge: {
      async selectDirectory() {
        return directoryChoices.shift() ?? null;
      },
    },
    localStorage: {
      getItem: (key) => storage.get(key) ?? null,
      setItem: (key, value) => storage.set(key, value),
      removeItem: (key) => storage.delete(key),
    },
  };
  globalThis.document = { addEventListener() {}, removeEventListener() {} };
  globalThis.EventSource = class {
    constructor() {
      throw new Error("Sidebar must use typed streams");
    }
  };
  t.mock.method(globalThis, "fetch", () => {
    throw new Error("Sidebar must use typed RPC");
  });
  let current, renderer;
  const deleted = [];
  const onSessionDeleted = (id) => deleted.push(id);
  const onSelectSession = () => {};
  const onCwdChange = (cwd) => selectedDirectories.push(cwd);
  function Probe() {
    current = useSessionList();
    return sidebar
      ? createElement(SessionSidebar, {
          sessionList: current,
          selectedSessionId: null,
          selectedCwd: "/project",
          onSelectSession,
          onSessionDeleted,
          onCwdChange,
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
    alerts,
    selectedDirectories,
    directoryChoices,
    mutations,
    unmount,
    async reply(index, value) {
      await act(async () => requests[index].resolve(value));
    },
    async fail(index, code, message) {
      await act(async () => requests[index].reject(new RpcError({ code, message })));
    },
    next(method) {
      const req = mutations.find((req) => req.method === method && !req.settled);
      assert.ok(req, "Missing " + method);
      return req;
    },
    async replyRpc(method, data) {
      const req = this.next(method);
      req.settled = true;
      await act(async () => req.resolve(data));
    },
    async failRpc(method, code, message) {
      const req = this.next(method);
      req.settled = true;
      await act(async () => req.reject(new RpcError({ code, message })));
    },
    async click(label) {
      const text = (node) => (typeof node === "string" ? node : (node.children?.map(text).join("") ?? ""));
      const node = renderer.root.find(
        (node) =>
          typeof node.type === "string" &&
          typeof node.props.onClick === "function" &&
          (node.props["aria-label"] === label || node.props.title === label || text(node) === label),
      );
      await act(async () => {
        void node.props.onClick({ stopPropagation() {}, preventDefault() {} });
      });
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
  assert.equal(fixture.sources[0].closed, 1);
});

test("live running status keeps precedence over a late list fallback", async (t) => {
  const fixture = await mount(t, { sidebar: true });
  await act(async () => fixture.sources[0].on({ type: "running", sessionIds: ["one"] }));
  await fixture.reply(0, response([session("one")], []));
  assert.equal(fixture.renderer.root.findAll((node) => node.props["aria-label"] === "Agent running").length, 1);
  await act(async () => fixture.sources[0].on({ type: "running", sessionIds: [] }));
  assert.equal(fixture.renderer.root.findAll((node) => node.props["aria-label"] === "Agent running").length, 0);
  assert.equal(fixture.requests.length, 1);
});

test("failed initial loading preserves unread markers and manual retry restores the list", async (t) => {
  const fixture = await mount(t, { sidebar: true, storedUnread: ["one"] });
  await fixture.fail(0, "FORBIDDEN", "Fixture access denied");
  assert.deepEqual(JSON.parse(fixture.storage.get("pi-desktop:unread-session-ids")), ["one"]);
  assert.match(JSON.stringify(fixture.renderer.toJSON()), /Fixture access denied/);
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

test("running subscriptions installed after unmount are released once", async (t) => {
  const pending = createDeferred();
  const fixture = await mount(t, { sidebar: true, runningInstallation: pending.promise });
  await fixture.reply(0, response([session("one")]));
  await fixture.unmount();
  await act(async () => pending.resolve());
  assert.equal(fixture.sources[0].closed, 1);
  await act(async () => fixture.sources[0].on({ type: "running", sessionIds: ["late"] }));
  assert.equal(fixture.requests.length, 1);
});

test("custom and native directory choices use canonical RPC results and preserve validation failures", async (t) => {
  const fixture = await mount(t, { sidebar: true });
  await fixture.reply(0, response([session("one")]));
  await fixture.click("/project");
  await fixture.click("Custom path…");
  const input = () =>
    fixture.renderer.root.find((node) => node.type === "input" && node.props.placeholder === "/path/to/project");
  await act(async () => input().props.onChange({ target: { value: "  /typed path  " } }));
  await act(async () => input().props.onKeyDown({ key: "Enter", preventDefault() {} }));
  assert.deepEqual(fixture.next("system.validateCwd").params, { path: "/typed path" });
  const previous = [...fixture.selectedDirectories];
  await fixture.replyRpc("system.validateCwd", { ok: false, error: "Not a directory" });
  assert.deepEqual(fixture.selectedDirectories, previous);
  assert.match(JSON.stringify(fixture.renderer.toJSON()), /Not a directory/);
  await act(async () => input().props.onKeyDown({ key: "Enter", preventDefault() {} }));
  await fixture.replyRpc("system.validateCwd", { ok: true, path: "/canonical" });
  assert.equal(fixture.selectedDirectories.at(-1), "/canonical");
  await fixture.click("/canonical");
  fixture.directoryChoices.push("/chosen with spaces");
  await fixture.click("Browse folder…");
  assert.deepEqual(fixture.next("system.validateCwd").params, { path: "/chosen with spaces" });
  await fixture.replyRpc("system.validateCwd", { ok: true, path: "/chosen-canonical" });
  assert.equal(fixture.selectedDirectories.at(-1), "/chosen-canonical");
  await fixture.click("/chosen-canonical");
  const count = fixture.mutations.length;
  await fixture.click("Browse folder…");
  assert.equal(fixture.mutations.length, count, "cancelled picker must not validate or change cwd");
  await fixture.click("Use default directory");
  await fixture.replyRpc("system.defaultCwd", { cwd: "/default" });
  assert.equal(fixture.selectedDirectories.at(-1), "/default");
});

test("rename commits typed id/name and relies on the index event without another list request", async (t) => {
  const fixture = await mount(t, { sidebar: true });
  await fixture.reply(0, response([session("one")]));
  await fixture.click("Session actions for one");
  await fixture.click("Rename");
  const editor = () => fixture.renderer.root.find((node) => node.type === "input" && node.props.value === "one");
  await act(async () => editor().props.onChange({ target: { value: "  Renamed  " } }));
  const renamedInput = fixture.renderer.root.find(
    (node) => node.type === "input" && node.props.value === "  Renamed  ",
  );
  await act(async () => renamedInput.props.onKeyDown({ key: "Enter" }));
  assert.deepEqual(fixture.next("sessions.rename").params, { id: "one", name: "Renamed" });
  await fixture.change({ cwd: "/project", session: session("one", "Renamed") });
  await fixture.replyRpc("sessions.rename", { ok: true });
  assert.equal(fixture.requests.length, 1);
  assert.ok(fixture.renderer.root.find((node) => node.props["aria-label"] === "Session actions for Renamed"));
});

test("delete retains running guards and backend conflicts without issuing an implicit force", async (t) => {
  const fixture = await mount(t, { sidebar: true });
  await fixture.reply(0, response([session("one")]));
  await act(async () => fixture.sources[0].on({ type: "running", sessionIds: ["one"] }));
  await fixture.click("Session actions for one");
  await fixture.click("Delete");
  assert.equal(fixture.mutations.length, 0);
  assert.match(fixture.alerts.at(-1), /still running/);
  await act(async () => fixture.sources[0].on({ type: "running", sessionIds: [] }));
  await fixture.click("Session actions for one");
  await fixture.click("Delete");
  await fixture.click("Delete");
  assert.deepEqual(fixture.next("sessions.delete").params, { id: "one" });
  await fixture.failRpc("sessions.delete", "CONFLICT", "Stop managed processes before deleting.");
  assert.deepEqual(fixture.deleted, []);
  assert.match(fixture.alerts.at(-1), /Stop managed processes/);
  await fixture.click("Session actions for one");
  await fixture.click("Delete");
  await fixture.click("Delete");
  await fixture.replyRpc("sessions.delete", { ok: true });
  await fixture.change({ cwd: "/project", sessionId: "one", deleted: true });
  assert.deepEqual(fixture.deleted, ["one"]);
});
