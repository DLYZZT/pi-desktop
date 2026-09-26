import assert from "node:assert/strict";
import test from "node:test";
import { portableGitNativePathEntries, portableGitShellEnvPatch, portableGitShellPathEntries } from "./environment.ts";

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
