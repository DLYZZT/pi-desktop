import assert from "node:assert/strict";
import test from "node:test";
import { windowsNativePathToMsys } from "./windows-path.ts";

test("converts only absolute native Windows paths to supported MSYS syntax", () => {
  assert.equal(windowsNativePathToMsys("C:\\Users\\李\\project"), "/c/Users/李/project");
  assert.equal(windowsNativePathToMsys("D:\\"), "/d");
  assert.equal(windowsNativePathToMsys("\\\\server\\share\\folder"), "//server/share/folder");
  assert.equal(windowsNativePathToMsys("relative\\path"), undefined);
  assert.equal(windowsNativePathToMsys("C:\\bad\npath"), undefined);
});
