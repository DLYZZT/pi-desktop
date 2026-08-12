import assert from "node:assert/strict";
import test from "node:test";

import { applyStrictOptionalPositiveInteger, parseStrictDecimalInteger } from "./strict-integer.ts";

test("strict decimal integers accept safe in-range ASCII digits", () => {
  assert.deepEqual(parseStrictDecimalInteger("1"), { kind: "valid", value: 1 });
  assert.deepEqual(parseStrictDecimalInteger("128000"), { kind: "valid", value: 128000 });
  assert.deepEqual(parseStrictDecimalInteger(String(Number.MAX_SAFE_INTEGER)), {
    kind: "valid",
    value: Number.MAX_SAFE_INTEGER,
  });
  assert.deepEqual(parseStrictDecimalInteger(""), { kind: "empty" });
});

test("strict decimal integers reject exponent, decimal, sign, whitespace, zero, and unsafe values", () => {
  for (const input of ["1e5", "1.5", "+12", "-12", " 12", "12 ", "0", "9007199254740992", "１２"]) {
    assert.deepEqual(parseStrictDecimalInteger(input), { kind: "invalid" }, input);
  }
});

test("invalid optional integer edits preserve the current value while empty clears it", () => {
  assert.equal(applyStrictOptionalPositiveInteger(128000, "1e5"), 128000);
  assert.equal(applyStrictOptionalPositiveInteger(128000, ""), undefined);
  assert.equal(applyStrictOptionalPositiveInteger(undefined, "16384"), 16384);
});
