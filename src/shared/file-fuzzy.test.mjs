import assert from "node:assert/strict";
import test from "node:test";

import {
  buildAtInsertText,
  buildAtMentionText,
  buildEntriesFromFiles,
  extractAtQuery,
  filterFileEntries,
} from "./file-fuzzy.ts";

test("at queries require a token boundary and support open quoted paths", () => {
  assert.deepEqual(extractAtQuery("open @src/fi"), { start: 5, query: "src/fi", quoted: false });
  assert.deepEqual(extractAtQuery('open @"my dir/fi'), { start: 5, query: "my dir/fi", quoted: true });
  assert.equal(extractAtQuery("mail@example.test"), null);
  assert.equal(extractAtQuery('open @"closed"'), null);
});

test("file entries derive directories and rank exact, prefix, path, and fuzzy matches", () => {
  const entries = buildEntriesFromFiles(["src/components/ChatInput.tsx", "src/chat.ts", "README.md"]);
  assert.deepEqual(
    entries.filter(({ isDir }) => isDir).map(({ path }) => path),
    ["src", "src/components"],
  );
  assert.equal(filterFileEntries(entries, "chat")[0].path, "src/chat.ts");
  assert.equal(filterFileEntries(entries, "src/components/")[0].path, "src/components/ChatInput.tsx");
  assert.equal(filterFileEntries(entries, "chinp")[0].path, "src/components/ChatInput.tsx");
});

test("insertions preserve drill-down caret and quote paths containing spaces", () => {
  assert.deepEqual(buildAtInsertText("my dir", true), { text: '@"my dir/"', cursorOffset: 9 });
  assert.deepEqual(buildAtInsertText("README.md", false), { text: "@README.md ", cursorOffset: 11 });
  assert.equal(buildAtMentionText("my dir", true), '@"my dir/" ');
});
