import assert from "node:assert/strict";
import test from "node:test";
import {
  portableGitNativePathEntries,
  portableGitShellEnvPatch,
  portableGitShellPathEntries,
  windowsNativePathToMsys,
} from "./environment.ts";

test("converts only absolute native Windows paths to supported MSYS syntax", () => {
  assert.equal(windowsNativePathToMsys("C:\\Users\\李\\project"), "/c/Users/李/project");
  assert.equal(windowsNativePathToMsys("D:\\"), "/d");
  assert.equal(windowsNativePathToMsys("\\\\server\\share\\folder"), "//server/share/folder");
  assert.equal(windowsNativePathToMsys("relative\\path"), undefined);
  assert.equal(windowsNativePathToMsys("C:\\bad\npath"), undefined);
});

test("keeps PortableGit native and MSYS path/environment additions separate", () => {
  const root = "C:\\Pi\\toolchains\\portable-git";
  assert.deepEqual(portableGitNativePathEntries(root), [`${root}\\cmd`]);
  assert.deepEqual(portableGitShellPathEntries(root), [
    `${root}\\cmd`,
    `${root}\\bin`,
    `${root}\\usr\\bin`,
    `${root}\\mingw64\\bin`,
  ]);
  assert.deepEqual(portableGitShellEnvPatch(), {
    MSYSTEM: "MINGW64",
    CHERE_INVOKING: "1",
    MSYS2_PATH_TYPE: "inherit",
  });
});
