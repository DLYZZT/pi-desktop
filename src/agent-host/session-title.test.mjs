import { test } from "node:test";
import assert from "node:assert/strict";
import { makeFallbackTitle, sanitizeGeneratedTitle, takeCodePoints } from "./session-title.ts";

test("sanitizeGeneratedTitle strips wrapping quotes and trailing punctuation", () => {
  assert.equal(sanitizeGeneratedTitle('"Fix the login page"'), "Fix the login page");
  assert.equal(sanitizeGeneratedTitle("修复登录页的样式问题。"), "修复登录页的样式问题");
  assert.equal(sanitizeGeneratedTitle("Debug the build failure!"), "Debug the build failure");
  assert.equal(sanitizeGeneratedTitle("「方案评审」"), "方案评审");
});

test("sanitizeGeneratedTitle collapses newlines and whitespace", () => {
  assert.equal(sanitizeGeneratedTitle("Fix\n the\r\nlogin\n page"), "Fix the login page");
});

test("sanitizeGeneratedTitle caps output at 40 characters", () => {
  const long = "a".repeat(120);
  const result = sanitizeGeneratedTitle(long);
  assert.equal(result.length, 40);
});

test("sanitizeGeneratedTitle returns null for empty or punctuation-only output", () => {
  assert.equal(sanitizeGeneratedTitle(""), null);
  assert.equal(sanitizeGeneratedTitle("   "), null);
  assert.equal(sanitizeGeneratedTitle("...。！"), null);
});

test("sanitizeGeneratedTitle keeps astral characters intact (length by code points)", () => {
  const result = sanitizeGeneratedTitle("😂".repeat(60));
  assert.equal([...result].length, 40);
});

test("makeFallbackTitle reuses the first characters of the message", () => {
  assert.equal(makeFallbackTitle("  Fix\n the login page  "), "Fix the login page");
  assert.equal(makeFallbackTitle("修复登录页的样式问题"), "修复登录页的样式问题");
});

test("makeFallbackTitle never returns an empty string", () => {
  assert.equal(makeFallbackTitle(""), "New session");
  assert.equal(makeFallbackTitle("   \n  "), "New session");
});

test("makeFallbackTitle caps output at 40 characters", () => {
  const result = makeFallbackTitle("x".repeat(80));
  assert.equal(result.length, 40);
});

test("takeCodePoints splits by code points, not UTF-16 units", () => {
  assert.equal(takeCodePoints("a😂b", 2), "a😂");
  assert.equal(takeCodePoints("abc", 2), "ab");
  assert.equal(takeCodePoints("abc", 0), "");
});
