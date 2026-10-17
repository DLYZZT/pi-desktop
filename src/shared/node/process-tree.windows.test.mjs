import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter } from "node:events";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { terminateProcessTree } from "./process-tree.ts";

function windowsFixture(t, spawn) {
  const platform = Object.getOwnPropertyDescriptor(process, "platform"),
    systemRoot = process.env.SystemRoot;
  Object.defineProperty(process, "platform", { ...platform, value: "win32" });
  process.env.SystemRoot = "R:\\Windows";
  t.mock.method(childProcess, "spawn", spawn);
  syncBuiltinESMExports();
  t.after(() => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
    Object.defineProperty(process, "platform", platform);
    if (systemRoot === undefined) delete process.env.SystemRoot;
    else process.env.SystemRoot = systemRoot;
  });
}
function child() {
  return Object.assign(new EventEmitter(), {
    pid: 4242,
    exitCode: null,
    signalCode: null,
    kill(signal) {
      this.signalCode = signal;
      this.emit("close");
      return true;
    },
  });
}

test("Windows force cleanup uses the fixed system taskkill and waits for tree completion", async (t) => {
  const root = child();
  let args;
  windowsFixture(t, (command, argv, options) => {
    args = { command, argv, options };
    const killer = new EventEmitter();
    globalThis.queueMicrotask(() => {
      root.exitCode = 1;
      root.emit("close");
      killer.emit("close", 0);
    });
    return killer;
  });
  await terminateProcessTree(root, 10, true);
  assert.equal(args.command, "R:\\Windows\\System32\\taskkill.exe");
  assert.deepEqual(args.argv, ["/PID", "4242", "/T", "/F"]);
  assert.equal(args.options.shell, false);
});

test("Windows cleanup failure is reported even when the shell exits; no exited PID is killed again", async (t) => {
  const root = child();
  let spawned = 0;
  windowsFixture(t, () => {
    spawned++;
    const killer = new EventEmitter();
    globalThis.queueMicrotask(() => {
      root.exitCode = 0;
      killer.emit("close", 1);
    });
    return killer;
  });
  await assert.rejects(terminateProcessTree(root, 10, true), /could not confirm process-tree termination/);
  await terminateProcessTree(root, 10, true);
  assert.equal(spawned, 1);
});

test("a hung Windows taskkill is bounded and cannot turn uncertain tree cleanup into success", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const root = child();
  let killed = false;
  windowsFixture(t, () =>
    Object.assign(new EventEmitter(), {
      kill() {
        killed = true;
        return true;
      },
    }),
  );
  const pending = assert.rejects(terminateProcessTree(root, 10, true), /could not confirm process-tree termination/);
  t.mock.timers.tick(5000);
  await Promise.resolve();
  await Promise.resolve();
  t.mock.timers.tick(10);
  await pending;
  assert.equal(killed, true);
  assert.equal(root.signalCode, "SIGKILL");
});
