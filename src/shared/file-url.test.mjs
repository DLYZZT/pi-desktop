import assert from "node:assert/strict";
import test from "node:test";

import {
  fileUrlToLocalPath,
  isLocalFilePathWithin,
  localFilePathToUrl,
  localFileReferenceToMarkdown,
  normalizeLocalFilePath,
  splitLocalFileReferenceMarkdown,
} from "./file-url.ts";

const roundTrips = [
  ["/tmp/a b#c?.txt", "file:///tmp/a%20b%23c%3F.txt"],
  ["C:\\Users\\me\\a b(1)%done.txt", "file:///C:/Users/me/a%20b%281%29%25done.txt"],
  ["\\\\server\\share\\目录\\report.docx", "file://server/share/%E7%9B%AE%E5%BD%95/report.docx"],
];

test("canonical file URLs round trip POSIX, Windows, and UNC paths", () => {
  for (const [filePath, expectedUrl] of roundTrips) {
    assert.equal(localFilePathToUrl(filePath), expectedUrl);
    assert.equal(fileUrlToLocalPath(expectedUrl), normalizeLocalFilePath(filePath));
  }
});

test("rejects relative, escaping, malformed, and four-slash file paths", () => {
  assert.equal(localFilePathToUrl("relative/file.txt"), null);
  assert.equal(localFilePathToUrl("/tmp/../../secret.txt"), null);
  assert.equal(fileUrlToLocalPath("file:////tmp/a.txt"), null);
  assert.equal(fileUrlToLocalPath("https://example.com/a.txt"), null);
  assert.equal(fileUrlToLocalPath("file:///tmp/a.txt?query"), null);
});

test("markdown serialization escapes labels and emits the canonical URL", () => {
  assert.equal(
    localFileReferenceToMarkdown({ name: "a[b].txt", path: "/tmp/a b.txt" }),
    "[a\\[b\\].txt](file:///tmp/a%20b.txt)",
  );
});

test("serialized local file references parse back into structured queue segments", () => {
  const markdown = localFileReferenceToMarkdown({ name: "a[b].txt", path: "/tmp/a b.txt" });
  assert.deepEqual(splitLocalFileReferenceMarkdown(`read ${markdown} next`), [
    { text: "read ", file: null },
    { text: "a[b].txt", file: { name: "a[b].txt", path: "/tmp/a b.txt" } },
    { text: " next", file: null },
  ]);
});

test("path containment uses component boundaries and Windows case folding", () => {
  assert.equal(isLocalFilePathWithin("/repo/a.txt", "/repo"), true);
  assert.equal(isLocalFilePathWithin("/repo-secret/a.txt", "/repo"), false);
  assert.equal(isLocalFilePathWithin("c:\\WORK\\a.txt", "C:/work"), true);
});
