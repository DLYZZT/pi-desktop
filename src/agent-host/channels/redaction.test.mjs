import assert from "node:assert/strict";
import test from "node:test";

import { fingerprintSecret, redactChannelText, redactChannelValue, safeChannelError } from "./redaction.ts";

test("structured channel redaction recursively removes every sensitive key", () => {
  assert.deepEqual(
    redactChannelValue({
      token: "top-secret",
      nested: [{ app_secret: "also-secret", safe: "visible" }],
      authorization: { value: "Bearer secret" },
    }),
    {
      token: "[REDACTED]",
      nested: [{ app_secret: "[REDACTED]", safe: "visible" }],
      authorization: "[REDACTED]",
    },
  );
});

test("text and error redaction covers headers, query parameters, Telegram bot URLs, and JSON", () => {
  const secret = "abcd1234-super-secret";
  const raw = `Bearer ${secret} https://api.telegram.org/bot${secret}/getMe?token=${secret} {"app_secret":"${secret}"}`;
  const redacted = redactChannelText(raw);
  assert.doesNotMatch(redacted, new RegExp(secret));
  assert.match(redacted, /Bearer \[REDACTED\]/);
  assert.match(redacted, /bot\[REDACTED\]/);
  assert.equal(safeChannelError(new Error(raw)).includes(secret), false);
  assert.equal(safeChannelError(new Error("x".repeat(700))).length, 500);
});

test("secret fingerprints reveal only the final four trimmed characters", () => {
  assert.equal(fingerprintSecret("  secret-value  "), "••••alue");
  assert.equal(fingerprintSecret("   "), undefined);
});
