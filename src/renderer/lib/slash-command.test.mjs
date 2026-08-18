import assert from "node:assert/strict";
import test from "node:test";

import { applySlashPrefix, extractSlashQuery, filterSlashItems } from "./slash-command.ts";

test("slash queries require a token boundary", () => {
  assert.deepEqual(extractSlashQuery("/"), { start: 0, query: "" });
  assert.deepEqual(extractSlashQuery("/cav"), { start: 0, query: "cav" });
  assert.deepEqual(extractSlashQuery("fix the bug /cav"), { start: 12, query: "cav" });
  assert.deepEqual(extractSlashQuery("fix the bug /"), { start: 12, query: "" });
  assert.deepEqual(extractSlashQuery("draft\n/skill:foo"), { start: 6, query: "skill:foo" });
  assert.equal(extractSlashQuery("src/foo"), null);
  assert.equal(extractSlashQuery("https://example"), null);
  assert.equal(extractSlashQuery("/caveman args"), null);
});

test("slash item filter matches name or description", () => {
  const items = [
    { name: "skill:caveman", description: "terse replies" },
    { name: "skill:grill-me", description: "interview the plan" },
  ];
  assert.deepEqual(
    filterSlashItems(items, "cav").map((item) => item.name),
    ["skill:caveman"],
  );
  assert.deepEqual(
    filterSlashItems(items, "interview").map((item) => item.name),
    ["skill:grill-me"],
  );
  assert.equal(filterSlashItems(items, "").length, 2);
});

test("applying a command prefixes the draft as args", () => {
  assert.equal(applySlashPrefix("/cav", { start: 0, query: "cav" }, "caveman"), "/caveman ");
  assert.equal(applySlashPrefix("fix the bug /cav", { start: 12, query: "cav" }, "caveman"), "/caveman fix the bug");
  assert.equal(applySlashPrefix("/fix the bug", { start: 0, query: "" }, "caveman"), "/caveman fix the bug");
  assert.equal(
    applySlashPrefix("please /cav do this", { start: 7, query: "cav" }, "caveman"),
    "/caveman please do this",
  );
});
