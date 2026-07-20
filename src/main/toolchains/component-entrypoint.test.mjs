import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { findComponentEntrypoints } from "./component-entrypoint.ts";

test("selects PortableGit cmd/git.exe and bin/bash.exe from the same component root", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-portable-entrypoints-"));
  try {
    for (const relative of ["cmd/git.exe", "mingw64/bin/git.exe", "bin/bash.exe", "usr/bin/bash.exe"]) {
      const absolute = path.join(root, ...relative.split("/"));
      fs.mkdirSync(path.dirname(absolute), { recursive: true });
      fs.writeFileSync(absolute, relative);
    }
    const entrypoints = findComponentEntrypoints("portable-git", root);
    assert.deepEqual(
      entrypoints.map((entrypoint) => [entrypoint.capability, path.relative(root, entrypoint.executable)]),
      [
        ["vcs.git", path.join("cmd", "git.exe")],
        ["shell.bash", path.join("bin", "bash.exe")],
      ],
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
