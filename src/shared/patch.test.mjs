import assert from "node:assert/strict";
import test from "node:test";

async function loadSubject() {
  return import("./patch.ts");
}

test("parses paired changes into split diff rows", async () => {
  const { parseUnifiedPatch } = await loadSubject();
  const files = parseUnifiedPatch(`--- a/demo.ts
+++ b/demo.ts
@@ -10,3 +10,3 @@
 const keep = true;
-const value = "old";
+const value = "new";
 done();
`);

  assert.equal(files?.length, 1);
  assert.equal(files?.[0].oldPath, "a/demo.ts");
  assert.equal(files?.[0].newPath, "b/demo.ts");
  assert.deepEqual(
    files?.[0].rows.filter((row) => row.type === "line"),
    [
      {
        type: "line",
        left: { lineNo: 10, text: "const keep = true;", type: "context" },
        right: { lineNo: 10, text: "const keep = true;", type: "context" },
      },
      {
        type: "line",
        left: { lineNo: 11, text: 'const value = "old";', type: "removed" },
        right: { lineNo: 11, text: 'const value = "new";', type: "added" },
      },
      {
        type: "line",
        left: { lineNo: 12, text: "done();", type: "context" },
        right: { lineNo: 12, text: "done();", type: "context" },
      },
    ],
  );
});

test("pads one-sided additions and removes timestamp suffixes from file paths", async () => {
  const { parseUnifiedPatch } = await loadSubject();
  const files = parseUnifiedPatch(`--- a/demo.ts\t2026-01-01
+++ b/demo.ts\t2026-01-02
@@ -1,1 +1,2 @@
 first
+second
`);

  assert.equal(files?.[0].oldPath, "a/demo.ts");
  assert.equal(files?.[0].newPath, "b/demo.ts");
  assert.deepEqual(files?.[0].rows.at(-1), {
    type: "line",
    left: { lineNo: null, text: "", type: "empty" },
    right: { lineNo: 2, text: "second", type: "added" },
  });
});

test("treats header-shaped deletion and addition lines as hunk content", async () => {
  const { parseUnifiedPatch } = await loadSubject();
  const files = parseUnifiedPatch(`--- a/options.txt
+++ b/options.txt
@@ -1 +1 @@
--- old option
+++ new option
`);

  assert.deepEqual(
    files?.[0].rows.filter((row) => row.type === "line"),
    [
      {
        type: "line",
        left: { lineNo: 1, text: "-- old option", type: "removed" },
        right: { lineNo: 1, text: "++ new option", type: "added" },
      },
    ],
  );
});

test("consumes exact hunk counts across multiple files and preserves no-newline markers", async () => {
  const { parseUnifiedPatch } = await loadSubject();
  const files = parseUnifiedPatch(`diff --git a/one.txt b/one.txt
--- a/one.txt
+++ b/one.txt
@@ -1,2 +1,2 @@
 keep
-old
\\ No newline at end of file
+new
\\ No newline at end of file
diff --git a/two.txt b/two.txt
--- a/two.txt
+++ b/two.txt
@@ -0,0 +1,2 @@
+++ text
+tail
`);

  assert.equal(files?.length, 2);
  assert.deepEqual(
    files?.map(({ oldPath, newPath }) => ({ oldPath, newPath })),
    [
      { oldPath: "a/one.txt", newPath: "b/one.txt" },
      { oldPath: "a/two.txt", newPath: "b/two.txt" },
    ],
  );
  assert.deepEqual(
    files?.[1].rows.filter((row) => row.type === "line"),
    [
      {
        type: "line",
        left: { lineNo: null, text: "", type: "empty" },
        right: { lineNo: 1, text: "++ text", type: "added" },
      },
      {
        type: "line",
        left: { lineNo: null, text: "", type: "empty" },
        right: { lineNo: 2, text: "tail", type: "added" },
      },
    ],
  );
  assert.equal(
    files?.[0].rows.filter((row) => row.type === "hunk" && row.text === "\\ No newline at end of file").length,
    2,
  );
});

test("rejects malformed or incomplete hunks so callers can render the raw patch", async () => {
  const { parseUnifiedPatch } = await loadSubject();

  assert.equal(
    parseUnifiedPatch(`--- a/demo.txt
+++ b/demo.txt
@@ -1,2 +1 @@
-only-one-old-line
+replacement
`),
    null,
  );
  assert.equal(
    parseUnifiedPatch(`--- a/demo.txt
+++ b/demo.txt
@@ -1 +1 @@
invalid-prefix
`),
    null,
  );
  assert.equal(
    parseUnifiedPatch(`--- a/demo.txt
+++ b/demo.txt
@@ malformed @@
`),
    null,
  );
});

test("returns null for text without diff lines", async () => {
  const { parseUnifiedPatch } = await loadSubject();

  assert.equal(parseUnifiedPatch("not a patch"), null);
});
