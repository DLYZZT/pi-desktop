import assert from "node:assert/strict";
import test from "node:test";
import { herdrErrorLabel, herdrRuntimeStatusLabel } from "./herdr-ui-copy.ts";

const t = (_key, fallback) => fallback;

test("Herdr UI copy maps runtime enums and public codes without exposing raw upstream messages", () => {
  assert.equal(herdrRuntimeStatusLabel("reconnecting", t), "Reconnecting");
  assert.equal(herdrRuntimeStatusLabel("degraded", t), "Read-only connection");
  const label = herdrErrorLabel({ code: "HERDR_ENDPOINT_UNSAFE", message: "/private/secret.sock owned by 501" }, t);
  assert.equal(label, "The Herdr Session endpoint did not pass local security checks.");
  assert.equal(label.includes("private"), false);
  assert.equal(
    herdrErrorLabel({ code: "HERDR_CONFIRMATION_REQUIRED", message: "/private/raw" }, t),
    "This Herdr operation requires an interactive local confirmation.",
  );
  assert.equal(
    herdrErrorLabel(new Error("untrusted wire payload"), t),
    "The Herdr operation failed. Try again or open diagnostics.",
  );
});
