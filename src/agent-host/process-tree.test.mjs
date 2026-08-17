import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { childPidsOf, commandPidsUnder, parseWmicTable } from "./process-tree.ts";

const source = readFileSync(new URL("./process-tree.ts", import.meta.url), "utf8");

test("Windows abort force-kills the tree instead of WM_CLOSE first", () => {
  const fnIndex = source.indexOf("export async function terminateProcessTree");
  assert.notEqual(fnIndex, -1);
  const block = source.slice(fnIndex, fnIndex + 500);
  assert.match(block, /taskkill\(processId, true\)/);
  assert.doesNotMatch(block, /taskkill\(processId, false\)/);
});

test("commandPidsUnder kills bash/ssh under host and skips fastctx/node", () => {
  assert.deepEqual(
    commandPidsUnder(10, [
      { pid: 10, ppid: 1, name: "electron.exe" },
      { pid: 20, ppid: 10, name: "bash.exe" },
      { pid: 21, ppid: 20, name: "ssh.exe" },
      { pid: 30, ppid: 10, name: "fastctx.exe" },
      { pid: 31, ppid: 10, name: "node.exe" },
    ]).sort((a, b) => a - b),
    [20, 21],
  );
});

test("childPidsOf returns direct host children only", () => {
  assert.deepEqual(
    childPidsOf(10, [
      { pid: 10, ppid: 1, name: "electron.exe" },
      { pid: 20, ppid: 10, name: "bash.exe" },
      { pid: 21, ppid: 20, name: "ssh.exe" },
      { pid: 22, ppid: 10, name: "cmd.exe" },
    ]).sort((a, b) => a - b),
    [20, 22],
  );
});

test("parseWmicTable reads the default list format, not CSV", () => {
  const text = [
    "Name                                ParentProcessId  ProcessId",
    "electron.exe                        61504            69368",
    "bash.exe                            69368            1111",
    "ssh.exe                             1111             2222",
  ].join("\r\n");
  assert.deepEqual(parseWmicTable(text), [
    { pid: 69368, ppid: 61504, name: "electron.exe" },
    { pid: 1111, ppid: 69368, name: "bash.exe" },
    { pid: 2222, ppid: 1111, name: "ssh.exe" },
  ]);
});
