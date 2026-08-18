import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

import {
  normalizeWorktreePathForComparison,
  removeWorktree,
  resolveProject,
  setGitCommandRunner,
  worktreePathsEqual,
} from "./worktree.ts";

test("Windows worktree paths compare independent of slash, drive case, path case, and trailing separators", () => {
  assert.equal(worktreePathsEqual("C:\\Users\\Dev\\Repo", "c:/users/dev/repo/", "win32"), true);
  assert.equal(worktreePathsEqual("C:\\Users\\Dev\\Repo", "D:/users/dev/repo", "win32"), false);
  assert.equal(worktreePathsEqual("\\\\Server\\Share\\Repo\\", "//server/share/repo", "win32"), true);
  assert.equal(normalizeWorktreePathForComparison("C:\\", "win32"), "c:/");
});

test("comparison helpers work without a process global, as in the sandboxed renderer", async () => {
  // The renderer main world is sandboxed: no `process`, and the platform
  // arrives via piBridge from the preload. Simulate that environment in a
  // child Node process — the parent test runner cannot drop its own process.
  const moduleUrl = new URL("./worktree-path.ts", import.meta.url).href;
  const source = `
    delete globalThis.process;
    globalThis.piBridge = { platform: "win32" };
    const { worktreePathsEqual } = await import(${JSON.stringify(moduleUrl)});
    if (!worktreePathsEqual("C:/Repo", "c:/repo")) throw new Error("piBridge platform not honored");
    delete globalThis.piBridge;
    if (worktreePathsEqual("C:/Repo", "c:/repo")) throw new Error("expected case-sensitive fallback");
  `;
  await execFileAsync(
    process.execPath,
    ["--disable-warning=MODULE_TYPELESS_PACKAGE_JSON", "--input-type=module", "-e", source],
    { timeout: 30_000 },
  );
});

test("POSIX worktree paths normalize separators without changing case", () => {
  assert.equal(worktreePathsEqual("/Users/Dev/Repo/", "/Users/Dev/Repo", "darwin"), true);
  assert.equal(worktreePathsEqual("/Users/Dev/Repo", "/users/dev/repo", "darwin"), false);
  assert.equal(normalizeWorktreePathForComparison("/", "linux"), "/");
});

test("git dir and common dir comparisons share the same Windows canonical rules", () => {
  assert.equal(worktreePathsEqual("C:\\repo\\.git", "c:/REPO/.git/", "win32"), true);
  assert.equal(worktreePathsEqual("C:\\repo\\.git\\worktrees\\feature", "c:/repo/.git", "win32"), false);
});

test("worktree removal matches alternate separators and passes Git its canonical path", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pi-worktree-path-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const main = path.join(directory, "repo");
  const linked = `${main}-worktrees${path.sep}feature`;
  fs.mkdirSync(main, { recursive: true });
  fs.mkdirSync(linked, { recursive: true });

  const calls = [];
  const restore = setGitCommandRunner({
    async run(cwd, args) {
      calls.push({ cwd, args });
      if (args[0] === "worktree" && args[1] === "list") {
        return {
          stdout: [
            `worktree ${main}`,
            "HEAD 0000000000000000000000000000000000000000",
            "branch refs/heads/main",
            "",
            `worktree ${linked}`,
            "HEAD 1111111111111111111111111111111111111111",
            "branch refs/heads/feature",
            "",
          ].join("\n"),
        };
      }
      return { stdout: "" };
    },
  });
  t.after(restore);

  await removeWorktree(main, linked.replaceAll(path.sep, path.sep === "/" ? "\\" : "/"));

  assert.deepEqual(calls.at(-1)?.args, ["worktree", "remove", linked]);
});

test("resolveProject returns the same git-reported projectRoot for main and linked worktree toplevels", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pi-project-root-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const main = path.join(directory, "repo");
  const linked = `${directory}${path.sep}repo-wt-feature`;
  fs.mkdirSync(main, { recursive: true });
  fs.mkdirSync(linked, { recursive: true });

  // git always reports forward slashes, even on Windows; a session cwd may
  // use backslashes there. projectRoot must be identical for both spellings.
  const realMain = fs.realpathSync(main);
  const realLinked = fs.realpathSync(linked);
  const mainFwd = realMain.replaceAll(path.sep, "/");
  const linkedFwd = realLinked.replaceAll(path.sep, "/");

  const restore = setGitCommandRunner({
    async run(cwd, args) {
      if (args[0] !== "rev-parse") return { stdout: "" };
      const isMain = fs.realpathSync(cwd) === realMain;
      const toplevel = isMain ? mainFwd : linkedFwd;
      const gitDir = isMain ? `${mainFwd}/.git` : `${mainFwd}/.git/worktrees/feature`;
      return { stdout: [`${mainFwd}/.git`, gitDir, toplevel, isMain ? "main" : "feature"].join("\n") };
    },
  });
  t.after(restore);

  // Spell the main cwd non-canonically; projectRoot must come from git
  // output, not from the verbatim cwd string.
  const mainInfo = await resolveProject(`${main}${path.sep}.`);
  assert.equal(mainInfo.isTopLevel, true);
  assert.equal(mainInfo.isWorktree, false);
  assert.equal(mainInfo.projectRoot, mainFwd);

  const linkedInfo = await resolveProject(linked);
  assert.equal(linkedInfo.isTopLevel, true);
  assert.equal(linkedInfo.isWorktree, true);
  assert.equal(linkedInfo.projectRoot, mainFwd);

  // The session list groups by exact projectRoot string after UI-side
  // normalization — both toplevels must yield the identical string.
  assert.equal(mainInfo.projectRoot, linkedInfo.projectRoot);
});

test("resolveProject keeps a repo subdirectory as its own project", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pi-project-subdir-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const main = path.join(directory, "repo");
  const subdir = path.join(main, "packages", "app");
  fs.mkdirSync(subdir, { recursive: true });

  const realMain = fs.realpathSync(main);
  const mainFwd = realMain.replaceAll(path.sep, "/");

  const restore = setGitCommandRunner({
    async run(_cwd, args) {
      if (args[0] !== "rev-parse") return { stdout: "" };
      return { stdout: [`${mainFwd}/.git`, `${mainFwd}/.git`, mainFwd, "main"].join("\n") };
    },
  });
  t.after(restore);

  const info = await resolveProject(subdir);
  assert.equal(info.isTopLevel, false);
  assert.equal(info.projectRoot, subdir);
});
