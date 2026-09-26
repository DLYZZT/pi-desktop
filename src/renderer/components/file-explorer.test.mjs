import assert from "node:assert/strict";
import path from "node:path";
import test, { after } from "node:test";
import { createElement, StrictMode } from "react";
import { act, create } from "react-test-renderer";
import { importTestBundle } from "#test-bundle";
import { createDeferred } from "#test-timing";

const previousActEnvironment = globalThis.IS_REACT_ACT_ENVIRONMENT;
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
after(() => {
  if (previousActEnvironment === undefined) delete globalThis.IS_REACT_ACT_ENVIRONMENT;
  else globalThis.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment;
});

const { FileExplorer, api } = await importTestBundle("file-explorer", {
  stdin: {
    contents: 'export {FileExplorer} from "./FileExplorer.tsx"; export * as api from "@/lib/api-client";',
    resolveDir: import.meta.dirname,
    loader: "ts",
  },
  tsconfig: path.join(import.meta.dirname, "../../../tsconfig.renderer.json"),
  external: ["react", "react-dom", "react-dom/*"],
  plugins: [
    {
      name: "file-explorer-i18n",
      setup(build) {
        build.onResolve({ filter: /^(?:@\/lib\/|\.\/)api-client$/ }, () => ({
          path: "api",
          namespace: "files-api-test",
        }));
        build.onLoad({ filter: /.*/, namespace: "files-api-test" }, () => ({
          contents: `
          let handler;
          export const sources = [], calls = [];
          export function reset(next) {handler = next; sources.length = calls.length = 0;}
          export async function call(method, params) { calls.push({method, params}); return handler(method, params); }
          export async function subscribe(topic, key, on) {
            const source = {topic, key, closed: false, emit: (event) => on({path: key, event})};
            sources.push(source);
            return () => {source.closed = true;};
          }
        `,
        }));
        build.onResolve({ filter: /^@\/i18n$/ }, () => ({ path: "i18n", namespace: "files-test" }));
        build.onLoad({ filter: /.*/, namespace: "files-test" }, () => ({
          contents: 'const t = (_key, fallback) => fallback; export function useI18n() {return {t, language: "en"};}',
        }));
      },
    },
  ],
});

const entry = (name, isDir = false) => ({ name, isDir, size: isDir ? 0 : 4, modified: "2026-09-26T00:00:00Z" });
const gitStatus = {
  isGit: true,
  branch: "main",
  clean: true,
  entries: [],
  staged: 0,
  modified: 0,
  untracked: 0,
  conflicted: 0,
};

async function mount(t, strict = false) {
  const timers = new Map();
  const nativeSetTimeout = globalThis.setTimeout,
    nativeClearTimeout = globalThis.clearTimeout;
  t.mock.method(globalThis, "setTimeout", (callback, delay, ...args) => {
    if (delay !== 200) return nativeSetTimeout(callback, delay, ...args);
    const id = {};
    timers.set(id, () => callback(...args));
    return id;
  });
  t.mock.method(globalThis, "clearTimeout", (id) => {
    if (timers.has(id)) timers.delete(id);
    else nativeClearTimeout(id);
  });
  const oldSource = Object.getOwnPropertyDescriptor(globalThis, "EventSource");
  globalThis.EventSource = class {
    constructor() {
      throw new Error("Legacy EventSource must not be used");
    }
  };
  t.mock.method(globalThis, "fetch", () => {
    throw new Error("Legacy fetch must not be used");
  });
  const requests = [];
  api.reset(async (method, params) => {
    if (method === "files.watchStart" || method === "files.watchStop") return { ok: true };
    assert.ok(method === "files.list" || method === "git.status");
    const kind = method === "git.status" ? "git" : "entries";
    const request = { ...createDeferred(), kind, directory: params.path, settled: false };
    requests.push(request);
    return request.promise;
  });
  const sources = api.sources;
  let props = { cwd: "/project", refreshKey: 0, onOpenFile: () => {} };
  const view = () =>
    strict ? createElement(StrictMode, null, createElement(FileExplorer, props)) : createElement(FileExplorer, props);
  let renderer;
  const unmount = async () => {
    if (renderer) await act(async () => renderer.unmount());
    renderer = null;
  };
  t.after(async () => {
    await unmount();
    if (oldSource) Object.defineProperty(globalThis, "EventSource", oldSource);
    else delete globalThis.EventSource;
  });
  await act(async () => {
    renderer = create(view());
  });
  const pending = (directory, kind) =>
    requests.find((request) => request.directory === directory && request.kind === kind && !request.settled);
  return {
    requests,
    sources,
    timers,
    unmount,
    text: () => JSON.stringify(renderer.toJSON()),
    count: (directory, kind = "entries") =>
      requests.filter((request) => request.directory === directory && request.kind === kind).length,
    async reply(directory, entries, status = 200) {
      await act(async () => {
        const listing = pending(directory, "entries");
        assert.ok(listing, `No pending listing for ${directory}`);
        listing.settled = true;
        if (status === 200) listing.resolve({ entries });
        else listing.reject(Object.assign(new Error(entries), { code: "FORBIDDEN" }));
        const git = pending(directory, "git");
        if (git) {
          git.settled = true;
          git.resolve(gitStatus);
        }
      });
    },
    async update(patch) {
      props = { ...props, ...patch };
      await act(async () => renderer.update(view()));
    },
    async click(label) {
      const button = renderer.root.find((node) => node.type === "button" && node.props["aria-label"] === label);
      await act(async () => button.props.onClick());
    },
    async watch(sourceIndex, event) {
      await act(async () => sources[sourceIndex].emit(event));
    },
    async fireTimers() {
      await act(async () => {
        const pending = [...timers.values()];
        timers.clear();
        pending.forEach((callback) => callback());
      });
    },
  };
}

test("a pending watch refresh merges with the explicit refresh for both entries and Git status", async (t) => {
  const fixture = await mount(t);
  await fixture.reply("/project", [entry("initial.txt")]);
  await fixture.watch(0, "change");
  await fixture.watch(0, "change");
  assert.equal(fixture.timers.size, 1);
  await fixture.update({ refreshKey: 1 });
  assert.equal(fixture.timers.size, 0);
  assert.equal(fixture.count("/project"), 2);
  assert.equal(fixture.count("/project", "git"), 2);
  await fixture.reply("/project", [entry("current.txt")]);
  await fixture.fireTimers();
  assert.equal(fixture.count("/project"), 2);
  assert.match(fixture.text(), /current\.txt/);
});

test("refresh during an expanded directory's first read queues a fresh result instead of losing the change", async (t) => {
  const fixture = await mount(t);
  await fixture.reply("/project", [entry("src", true)]);
  await fixture.click("Expand folder src");
  assert.equal(fixture.count("/project/src"), 1);
  await fixture.update({ refreshKey: 1 });
  await fixture.reply("/project", [entry("src", true)]);
  assert.equal(fixture.count("/project/src"), 1, "directory reads must not run concurrently");
  await fixture.reply("/project/src", [entry("obsolete.ts")]);
  assert.doesNotMatch(fixture.text(), /obsolete\.ts/);
  assert.equal(fixture.count("/project/src"), 2);
  await fixture.reply("/project/src", [entry("current.ts")]);
  assert.match(fixture.text(), /current\.ts/);
});

test("collapsed directory changes load lazily on the next expansion", async (t) => {
  const fixture = await mount(t);
  await fixture.reply("/project", [entry("src", true)]);
  await fixture.click("Expand folder src");
  await fixture.reply("/project/src", [entry("old.ts")]);
  await fixture.click("Collapse folder src");
  await fixture.update({ refreshKey: 1 });
  await fixture.reply("/project", [entry("src", true)]);
  assert.equal(fixture.count("/project/src"), 1);
  await fixture.click("Expand folder src");
  assert.equal(fixture.count("/project/src"), 2);
  await fixture.reply("/project/src", [entry("new.ts")]);
  assert.match(fixture.text(), /new\.ts/);
  assert.doesNotMatch(fixture.text(), /old\.ts/);
});

test("nested expanded directories load again when their parent remounts them", async (t) => {
  const fixture = await mount(t);
  await fixture.reply("/project", [entry("src", true)]);
  await fixture.click("Expand folder src");
  await fixture.reply("/project/src", [entry("nested", true)]);
  await fixture.click("Expand folder nested");
  await fixture.reply("/project/src/nested", [entry("deep.ts")]);
  await fixture.click("Collapse folder src");
  await fixture.click("Expand folder src");
  assert.equal(fixture.count("/project/src"), 1);
  assert.equal(fixture.count("/project/src/nested"), 2);
  await fixture.reply("/project/src/nested", [entry("deep.ts")]);
  assert.match(fixture.text(), /deep\.ts/);
});

test("workspace changes discard old results and late watch events, including pending debounces", async (t) => {
  const fixture = await mount(t);
  await fixture.watch(0, "change");
  await fixture.update({ cwd: "/second" });
  assert.equal(fixture.sources[0].closed, true);
  assert.equal(fixture.timers.size, 0);
  await fixture.reply("/second", [entry("second.txt")]);
  await fixture.reply("/project", [entry("old-project.txt")]);
  await fixture.watch(0, "connected");
  await fixture.watch(0, "change");
  await fixture.fireTimers();
  assert.equal(fixture.count("/second"), 1);
  assert.doesNotMatch(fixture.text(), /old-project/);
  assert.match(fixture.text(), /Project changes are monitored/);
  assert.match(fixture.text(), /second\.txt/);
  await fixture.watch(1, "change");
  assert.equal(fixture.timers.size, 1);
  await fixture.unmount();
  assert.equal(fixture.sources[1].closed, true);
  assert.equal(fixture.timers.size, 0);
});

test("file load errors stay visible and a later explicit refresh can recover", async (t) => {
  const fixture = await mount(t);
  await fixture.reply("/project", "Permission denied", 403);
  assert.match(fixture.text(), /Permission denied/);
  assert.equal(fixture.count("/project"), 1);
  await fixture.update({ refreshKey: 1 });
  await fixture.reply("/project", [entry("recovered.txt")]);
  assert.match(fixture.text(), /recovered\.txt/);
  assert.doesNotMatch(fixture.text(), /Permission denied/);
});

test("Strict Mode's replaced lifecycle closes its watch and does not start a duplicate initial read", async (t) => {
  const fixture = await mount(t, true);
  assert.equal(fixture.sources.length, 2);
  assert.equal(fixture.sources[0].closed, true);
  assert.equal(fixture.count("/project"), 1);
  assert.equal(fixture.count("/project", "git"), 1);
  await fixture.reply("/project", [entry("current.txt")]);
  assert.match(fixture.text(), /current\.txt/);
  await fixture.unmount();
  assert.equal(fixture.sources[1].closed, true);
});
