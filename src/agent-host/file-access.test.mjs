import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { canonicalPath, isFilePathAllowed, isWindowsAbsolutePath } from "./file-access-core.ts";

test("accepts a root and its descendants without accepting prefix collisions", () => {
  const root = path.join(tmpdir(), "pi-file-access-root");
  const roots = new Set([root]);

  assert.equal(isFilePathAllowed(root, roots), true);
  assert.equal(isFilePathAllowed(path.join(root, "nested", "file.txt"), roots), true);
  assert.equal(isFilePathAllowed(`${root}-evil/file.txt`, roots), false);
});

test("normalizes traversal, repeated separators, and trailing separators", () => {
  const root = path.join(tmpdir(), "pi-file-access-normalize");
  const roots = new Set([`${root}${path.sep}`]);

  assert.equal(isFilePathAllowed(path.join(root, "a", "..", "b"), roots), true);
  assert.equal(isFilePathAllowed(`${root}${path.sep}${path.sep}b`, roots), true);
  assert.equal(isFilePathAllowed(path.join(root, "..", "outside"), roots), false);
});

test("resolves existing symlinks and rejects escapes", (t) => {
  const base = mkdtempSync(path.join(tmpdir(), "pi-file-access-symlink-"));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const root = path.join(base, "root");
  const outside = path.join(base, "outside");
  mkdirSync(root);
  mkdirSync(outside);
  writeFileSync(path.join(outside, "secret.txt"), "secret");
  symlinkSync(outside, path.join(root, "escape"), process.platform === "win32" ? "junction" : "dir");

  assert.equal(isFilePathAllowed(path.join(root, "escape", "secret.txt"), new Set([root])), false);
});

test("resolves the nearest existing ancestor before appending missing segments", (t) => {
  const base = mkdtempSync(path.join(tmpdir(), "pi-file-access-missing-"));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const root = path.join(base, "root");
  const outside = path.join(base, "outside");
  mkdirSync(root);
  mkdirSync(outside);
  symlinkSync(outside, path.join(root, "escape"), process.platform === "win32" ? "junction" : "dir");

  const target = path.join(root, "escape", "not-created", "file.txt");
  const realpath = realpathSync.native ?? realpathSync;
  assert.equal(canonicalPath(target, false), path.join(realpath(outside), "not-created", "file.txt"));
  assert.equal(isFilePathAllowed(target, new Set([root])), false);
});

test("allows a non-existent child when its existing parent is inside the root", (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "pi-file-access-parent-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));

  assert.equal(isFilePathAllowed(path.join(root, "new-file.txt"), new Set([root])), true);
});

test("applies case-insensitive Windows drive rules and path boundaries", () => {
  const roots = new Set(["C:\\Users\\Alice\\Project"]);

  assert.equal(isWindowsAbsolutePath("c:\\Users\\Alice"), true);
  assert.equal(isFilePathAllowed("c:/users/ALICE/project/src/app.ts", roots), true);
  assert.equal(isFilePathAllowed("C:\\Users\\Alice\\Project-Evil\\app.ts", roots), false);
});

test("supports UNC roots without accepting a sibling share prefix", () => {
  const roots = new Set(["\\\\server\\share\\Project"]);

  assert.equal(isWindowsAbsolutePath("//server/share/Project"), true);
  assert.equal(isFilePathAllowed("//SERVER/share/project/src/app.ts", roots), true);
  assert.equal(isFilePathAllowed("//server/share/Project-Evil/app.ts", roots), false);
});

test("rejects unrelated relative and mixed-style paths", () => {
  assert.equal(isFilePathAllowed("relative/file.txt", new Set(["/definitely/not/the/current/directory"])), false);
  assert.equal(isFilePathAllowed("/tmp/project/file.txt", new Set(["C:\\tmp\\project"])), false);
  assert.equal(isFilePathAllowed("/tmp/project/file.txt", new Set()), false);
});
