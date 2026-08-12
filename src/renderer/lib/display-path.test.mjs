import { importTestBundle } from "#test-bundle";
import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
const { abbreviateHomePath } = await importTestBundle("src/renderer/lib/display-path", {
  entryPoints: [path.join(import.meta.dirname, "display-path.ts")],
});

test("POSIX home abbreviation requires an exact path-segment boundary", () => {
  assert.equal(abbreviateHomePath("/Users/foo", "/Users/foo"), "~");
  assert.equal(abbreviateHomePath("/Users/foo/work/app", "/Users/foo/"), "~/work/app");
  assert.equal(abbreviateHomePath("/Users/foobar/work", "/Users/foo"), "/Users/foobar/work");
  assert.equal(abbreviateHomePath("/users/foo/work", "/Users/foo"), "/users/foo/work");
});

test("Windows paths compare case-insensitively with either separator", () => {
  assert.equal(abbreviateHomePath("c:\\USERS\\Foo\\work", "C:\\Users\\foo"), "~\\work");
  assert.equal(abbreviateHomePath("C:/Users/FOO/work", "c:\\users\\foo\\"), "~/work");
  assert.equal(abbreviateHomePath("C:\\Users\\foobar", "C:\\Users\\foo"), "C:\\Users\\foobar");
});

test("empty home and root homes remain well-defined", () => {
  assert.equal(abbreviateHomePath("/workspace", ""), "/workspace");
  assert.equal(abbreviateHomePath("/workspace", "/"), "~/workspace");
  assert.equal(abbreviateHomePath("C:\\workspace", "C:\\"), "~\\workspace");
});
