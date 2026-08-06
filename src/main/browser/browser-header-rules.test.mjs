import assert from "node:assert/strict";
import test from "node:test";
import { applyHeaderRules, validateHeaderRules } from "./browser-header-rules.ts";

test("header rules validate scope and apply set, append, remove, secret, and resource filters", () => {
  const rules = validateHeaderRules(
    "profile",
    [
      {
        id: "one",
        enabled: true,
        profileId: "profile",
        urlPattern: "https://*.example.com/*",
        header: "X-One",
        operation: "set",
        value: "1",
      },
      {
        id: "two",
        enabled: true,
        profileId: "profile",
        urlPattern: "https://*.example.com/*",
        resourceTypes: ["xhr"],
        header: "x-list",
        operation: "append",
        value: "b",
      },
      { id: "three", enabled: true, profileId: "profile", urlPattern: "*", header: "x-remove", operation: "remove" },
      {
        id: "four",
        enabled: true,
        profileId: "profile",
        urlPattern: "*",
        header: "authorization",
        operation: "set",
        secretRef: "browser-secret-12345678",
      },
    ],
    "request",
  );
  assert.deepEqual(
    applyHeaderRules(
      { "x-list": "a", "x-remove": "gone" },
      rules,
      "https://api.example.com/a",
      "xhr",
      () => "Bearer token",
    ),
    { "x-list": ["a", "b"], "x-one": "1", authorization: "Bearer token" },
  );
});

test("header rules reject transport, Authorization plaintext, and site-security response overrides", () => {
  const base = { id: "one", enabled: true, profileId: "p", urlPattern: "*", operation: "set", value: "x" };
  assert.throws(() => validateHeaderRules("p", [{ ...base, header: "Host" }], "request"), /cannot be overridden/);
  assert.throws(() => validateHeaderRules("p", [{ ...base, header: "Authorization" }], "request"), /secure secret/);
  assert.throws(
    () => validateHeaderRules("p", [{ ...base, header: "Content-Security-Policy" }], "response"),
    /Advanced Browser Mode Profile/,
  );
  assert.equal(validateHeaderRules("p", [{ ...base, header: "Content-Security-Policy" }], "response", true).length, 1);
});
