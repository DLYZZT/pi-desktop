import assert from "node:assert/strict";
import test from "node:test";
import { mergeDictionaries } from "./merge-dictionaries.ts";

test("domain aggregation keeps values, accepts prototype-like keys and rejects duplicate ownership", () => {
  const common = { save: "Save" },
    files = { download: "Download" };
  const merged = mergeDictionaries(common, files, JSON.parse('{"__proto__":"literal", "constructor":"label"}'));
  assert.equal(merged.save, "Save");
  assert.equal(merged.download, "Download");
  assert.equal(merged.__proto__, "literal");
  assert.equal(merged.constructor, "label");
  assert.deepEqual(common, { save: "Save" });
  assert.deepEqual(files, { download: "Download" });
  assert.throws(() => mergeDictionaries(common, { save: "Save" }), /Duplicate translation key: save/);
});
