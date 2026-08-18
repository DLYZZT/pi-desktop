import assert from "node:assert/strict";
import test from "node:test";

import { createSessionPtyManager, bundledPiCliPath } from "./session-pty.ts";

function createFakePty(pid) {
  let onData = () => {};
  let onExit = () => {};
  return {
    pid,
    writes: [],
    resizes: [],
    killed: false,
    onData(listener) {
      onData = listener;
      return { dispose() {} };
    },
    onExit(listener) {
      onExit = listener;
      return { dispose() {} };
    },
    write(data) {
      this.writes.push(data);
    },
    resize(cols, rows) {
      this.resizes.push([cols, rows]);
    },
    kill() {
      this.killed = true;
    },
    emitData(data) {
      onData(data);
    },
    emitExit(exitCode = 0) {
      onExit({ exitCode, signal: 0 });
    },
  };
}

test("existing sessions resume by path while new sessions create an exact id in their cwd", () => {
  const spawned = [];
  const manager = createSessionPtyManager({
    spawn(file, args, options) {
      const pty = createFakePty(spawned.length + 1);
      spawned.push({ file, args, options, pty });
      return pty;
    },
  });

  const first = manager.start({
    sessionId: "sess-1",
    sessionPath: "F:/PiData/session-1.jsonl",
    cwd: "F:/project-one",
    nodeExecutable: "C:/Node/node.exe",
    program: "F:/bundled/pi-cli.js",
  });
  manager.start({
    sessionId: "sess-2",
    cwd: "F:/project-two",
    nodeExecutable: "C:/Node/node.exe",
    program: "F:/bundled/pi-cli.js",
  });
  const firstAgain = manager.start({
    sessionId: "sess-1",
    sessionPath: "F:/PiData/session-1.jsonl",
    cwd: "F:/project-one",
    nodeExecutable: "C:/Node/node.exe",
    program: "F:/bundled/pi-cli.js",
  });

  assert.equal(first.action, "spawn");
  assert.equal(firstAgain.action, "focus");
  assert.equal(spawned.length, 2);
  assert.deepEqual(spawned[0].args, ["F:/bundled/pi-cli.js", "--session", "F:/PiData/session-1.jsonl"]);
  assert.equal(spawned[0].options.cwd, "F:/project-one");
  assert.deepEqual(spawned[1].args, ["F:/bundled/pi-cli.js", "--session-id", "sess-2"]);
  assert.equal(spawned[1].options.cwd, "F:/project-two");
  assert.equal(spawned[0].options.name, "xterm-256color");
  assert.equal(manager.snapshotMarks()["sess-1"], "running");
  assert.equal(manager.snapshotMarks()["sess-2"], "running");
});

test("PTY output, input and resize stay scoped to the matching session", () => {
  const spawned = [];
  const output = [];
  const manager = createSessionPtyManager({
    spawn() {
      const pty = createFakePty(1);
      spawned.push(pty);
      return pty;
    },
    onData(sessionId, data) {
      output.push([sessionId, data]);
    },
  });
  const request = {
    sessionId: "sess-1",
    cwd: "F:/project",
    nodeExecutable: "C:/Node/node.exe",
    program: "F:/bundled/pi-cli.js",
  };

  manager.start(request, { cols: 100, rows: 40 });
  spawned[0].emitData("hello");
  manager.write("sess-1", "input");
  manager.resize("sess-1", 120, 50);
  manager.write("unknown", "ignored");

  assert.deepEqual(output, [["sess-1", "hello"]]);
  assert.deepEqual(spawned[0].writes, ["input"]);
  assert.deepEqual(spawned[0].resizes, [[120, 50]]);
});

test("exited sessions become dead and can be restarted", () => {
  const spawned = [];
  const exits = [];
  const manager = createSessionPtyManager({
    spawn() {
      const pty = createFakePty(spawned.length + 1);
      spawned.push(pty);
      return pty;
    },
    onExit(sessionId, exitCode) {
      exits.push([sessionId, exitCode]);
    },
  });
  const request = {
    sessionId: "sess-1",
    cwd: "F:/project",
    nodeExecutable: "C:/Node/node.exe",
    program: "F:/bundled/pi-cli.js",
  };

  manager.start(request);
  spawned[0].emitExit(7);
  assert.equal(manager.snapshotMarks()["sess-1"], "dead");
  manager.start(request);
  assert.equal(spawned.length, 2);
  assert.deepEqual(exits, [["sess-1", 7]]);
});

test("real app quit kills every embedded PTY", () => {
  const spawned = [];
  const manager = createSessionPtyManager({
    spawn() {
      const pty = createFakePty(spawned.length + 1);
      spawned.push(pty);
      return pty;
    },
  });
  const base = {
    cwd: "F:/project",
    nodeExecutable: "C:/Node/node.exe",
    program: "F:/bundled/pi-cli.js",
  };
  manager.start({ ...base, sessionId: "sess-1" });
  manager.start({ ...base, sessionId: "sess-2" });

  manager.killAll();

  assert.equal(
    spawned.every((pty) => pty.killed),
    true,
  );
  assert.deepEqual(manager.snapshotMarks(), {});
});

test("bundled Pi resolves to the packaged CLI instead of PATH pi", () => {
  assert.match(bundledPiCliPath().replaceAll("\\", "/"), /@earendil-works\/pi-coding-agent\/dist\/cli\.js$/);
});
