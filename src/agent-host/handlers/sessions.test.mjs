import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { importTestBundle } from "#test-bundle";
import { createDeferred } from "#test-timing";

const fixtureModule = await importTestBundle("session-handler-order", {
  packages: "external",
  stdin: {
    contents:
      'export {createSessionHandlers} from "./sessions.ts"; export * as runtime from "../rpc-manager"; export * as reader from "../session-reader"; export * as index from "../session-index"; export * as main from "../parent-rpc";',
    resolveDir: import.meta.dirname,
    loader: "ts",
  },
  plugins: [
    {
      name: "controlled-session-services",
      setup(build) {
        build.onResolve(
          { filter: /(?:^|\/)(rpc-manager|session-reader|session-index|parent-rpc)(?:\.ts)?$/ },
          ({ path: specifier }) => ({
            path: path.basename(specifier).replace(/\.ts$/, ""),
            namespace: "session-services",
          }),
        );
        build.onLoad({ filter: /.*/, namespace: "session-services" }, ({ path: name }) => ({
          loader: "js",
          contents: {
            "rpc-manager":
              "let session; export const setSession = value => {session = value;}; export const getRpcSession = () => session; export const getRunningRpcSessionIds = () => [];",
            "session-reader":
              "let file; export const invalidated = []; export const setFile = value => {file=value; invalidated.length=0;}; export const resolveSessionPath = async () => file; export const invalidateSessionPathCache = id => invalidated.push(id); export const listAllSessions = async () => []; export const getSessionIndexMetrics = () => ({}); export const buildSessionContext = () => ({}); export const buildSessionInfoFromManager = async () => ({}); const unexpected = () => {throw new Error('Unexpected history conversion');}; export {unexpected as entryToUiMessage, unexpected as parseChannelSourceMarker, unexpected as parseRunId, unexpected as withUserMessageSource};",
            "session-index":
              "export const removed = []; export const sessionIndex = {removePath(file) {removed.push(file); return {cwd:'/fixture'};}, async refreshPath() {return null;}};",
            "parent-rpc": "export const calls = []; export const callMain = async (...args) => {calls.push(args);};",
          }[name],
        }));
      },
    },
  ],
});

function createFixture(t, active = true) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pi-session-delete-"));
  const file = path.join(directory, "session.jsonl");
  fs.writeFileSync(file, "owned fixture");
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const { runtime, reader, index, main, createSessionHandlers } = fixtureModule;
  reader.setFile(file);
  index.removed.length = main.calls.length = 0;
  const stopped = createDeferred(),
    finishStop = createDeferred();
  const disposing = createDeferred(),
    finishDispose = createDeferred();
  const order = [],
    events = [];
  runtime.setSession({
    sessionId: "session",
    isAlive: () => true,
    isRunning: () => true,
    async abortAndDispose() {
      order.push("dispose");
      disposing.resolve();
      await finishDispose.promise;
      order.push("disposed");
    },
  });
  const handlers = createSessionHandlers({
    server: { emit: (...event) => events.push(event) },
    managedProcesses: {
      activeForSession: () => (active ? [{ processId: "process", runId: "run" }] : []),
      async stop(...args) {
        assert.deepEqual(args, ["process", "run", "graceful", "user"]);
        order.push("stop");
        stopped.resolve();
        await finishStop.promise;
        order.push("stopped");
      },
    },
    clearSessionEventBinding: (id) => {
      assert.equal(id, "session");
      assert.equal(fs.existsSync(file), true);
      order.push("unbind");
    },
  });
  return { file, handlers, stopped, finishStop, disposing, finishDispose, order, events, index, reader, main };
}

test("forced deletion waits for process and Agent shutdown before unlinking and publishing", async (t) => {
  const fixture = createFixture(t);
  const deletion = fixture.handlers.delete({ id: "session", force: true });
  await fixture.stopped.promise;
  assert.equal(fs.existsSync(fixture.file), true);
  assert.deepEqual(fixture.order, ["stop"]);
  fixture.finishStop.resolve();
  await fixture.disposing.promise;
  assert.equal(fs.existsSync(fixture.file), true);
  assert.deepEqual(fixture.order, ["stop", "stopped", "dispose"]);
  fixture.finishDispose.resolve();
  assert.deepEqual(await deletion, { ok: true });
  assert.equal(fs.existsSync(fixture.file), false);
  assert.deepEqual(fixture.order, ["stop", "stopped", "dispose", "disposed", "unbind"]);
  assert.deepEqual(fixture.index.removed, [fixture.file]);
  assert.deepEqual(fixture.reader.invalidated, ["session"]);
  assert.deepEqual(fixture.main.calls, [["browser.sessionEnded", { sessionId: "session" }]]);
  assert.deepEqual(fixture.events, [
    ["sessions.changed", "session", { cwd: "/fixture", sessionId: "session", deleted: true }],
  ]);
});

test("stop failure keeps the file, event binding and notifications intact", async (t) => {
  const fixture = createFixture(t);
  const deletion = fixture.handlers.delete({ id: "session", force: true });
  const rejected = assert.rejects(deletion, /stop failed/);
  await fixture.stopped.promise;
  fixture.finishStop.reject(new Error("stop failed"));
  await rejected;
  assert.equal(fs.existsSync(fixture.file), true);
  assert.deepEqual(fixture.order, ["stop"]);
  assert.deepEqual(fixture.events, []);
  assert.deepEqual(fixture.index.removed, []);
});

test("Agent disposal failure also leaves the session file and binding in place", async (t) => {
  const fixture = createFixture(t, false);
  const deletion = fixture.handlers.delete({ id: "session", force: true });
  const rejected = assert.rejects(deletion, /dispose failed/);
  await fixture.disposing.promise;
  fixture.finishDispose.reject(new Error("dispose failed"));
  await rejected;
  assert.equal(fs.existsSync(fixture.file), true);
  assert.deepEqual(fixture.order, ["dispose"]);
  assert.deepEqual(fixture.events, []);
  assert.deepEqual(fixture.index.removed, []);
});

test("an active process or Agent blocks unforced deletion without side effects", async (t) => {
  for (const active of [true, false]) {
    const fixture = createFixture(t, active);
    await assert.rejects(fixture.handlers.delete({ id: "session" }), (error) => error.code === "CONFLICT");
    assert.equal(fs.existsSync(fixture.file), true);
    assert.deepEqual(fixture.order, []);
    assert.deepEqual(fixture.events, []);
  }
});
