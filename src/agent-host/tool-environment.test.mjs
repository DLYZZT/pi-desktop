import assert from "node:assert/strict";
import test from "node:test";
import { sanitizeToolEnvironment } from "./tool-environment.ts";

test("removes inherited credential variables from project tool environments", () => {
  const sanitized = sanitizeToolEnvironment({
    Path: "C:\\Windows\\System32",
    SAFE_VALUE: "kept",
    XAI_API_KEY: "provider-secret",
    CLI_PROXY_API_KEY: "proxy-secret",
    GITHUB_TOKEN: "github-secret",
    AWS_SECRET_ACCESS_KEY: "aws-secret",
    AWS_ACCESS_KEY_ID: "aws-id",
    PIP_INDEX_URL: "https://user:password@example.invalid/simple",
  });

  assert.deepEqual(sanitized, {
    Path: "C:\\Windows\\System32",
    SAFE_VALUE: "kept",
  });
});

test("keeps non-credential URLs and ordinary project environment", () => {
  const sanitized = sanitizeToolEnvironment({
    DATABASE_HOST: "127.0.0.1",
    PUBLIC_API_URL: "https://example.invalid/api",
    HTTPS_PROXY: "http://proxy.example.invalid:8080",
  });

  assert.deepEqual(sanitized, {
    DATABASE_HOST: "127.0.0.1",
    PUBLIC_API_URL: "https://example.invalid/api",
    HTTPS_PROXY: "http://proxy.example.invalid:8080",
  });
});
