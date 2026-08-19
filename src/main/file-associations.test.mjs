import assert from "node:assert/strict";
import test from "node:test";

import { buildOpenWithInvocation, isSafeOpenHandlerCommand, parseWindowsCommandLine } from "./file-associations.ts";

test("Windows command parser handles quoted executables, spaces, and escaped quotes", () => {
  assert.deepEqual(parseWindowsCommandLine('"C:\\Program Files\\Editor\\edit.exe" --flag "%1"'), [
    "C:\\Program Files\\Editor\\edit.exe",
    "--flag",
    "%1",
  ]);
  assert.deepEqual(parseWindowsCommandLine('editor.exe "a\\"b"'), ["editor.exe", 'a"b']);
  assert.deepEqual(parseWindowsCommandLine('"unterminated.exe'), []);
});

test("Open With invocation supports common placeholders without a shell", () => {
  const target = "C:\\Work Files\\report.txt";
  for (const placeholder of ["%1", "%L", "%l", "%V", "%v", "%*"]) {
    assert.deepEqual(buildOpenWithInvocation(`editor.exe --open "${placeholder}"`, target), {
      exe: "editor.exe",
      args: ["--open", target],
    });
  }
  assert.deepEqual(
    buildOpenWithInvocation('"%ProgramFiles%\\Editor\\edit.exe" "%1"', target, {
      ProgramFiles: "C:\\Program Files",
    }),
    {
      exe: "C:\\Program Files\\Editor\\edit.exe",
      args: [target],
    },
  );
});

test("Open With invocation appends a target when the command has no placeholder and rejects placeholder executables", () => {
  assert.deepEqual(buildOpenWithInvocation("editor.exe --new-window", "C:\\a.txt"), {
    exe: "editor.exe",
    args: ["--new-window", "C:\\a.txt"],
  });
  assert.equal(buildOpenWithInvocation('"%1"', "C:\\a.exe"), null);
});

test("Open With hides shell-backed and unresolved handler commands", () => {
  assert.equal(
    isSafeOpenHandlerCommand('"%ComSpec%" /c editor "%1"', { ComSpec: "C:\\Windows\\System32\\cmd.exe" }),
    false,
  );
  assert.equal(isSafeOpenHandlerCommand('"%MissingEditor%\\edit.exe" "%1"', {}), false);
  assert.equal(isSafeOpenHandlerCommand('"C:\\Program Files\\Editor\\edit.exe" "%1"'), true);
});
