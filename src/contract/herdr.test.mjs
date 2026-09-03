import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_HERDR_SETTINGS,
  HERDR_AGENT_PROMPT_MAX_BYTES,
  HERDR_AGENT_ALIAS_PATTERN,
  HERDR_AGENT_KINDS,
  HERDR_AGENT_WAIT_MAX_MS,
  HERDR_PANE_READ_MAX_BYTES,
  HERDR_PROTOCOL_VERSION,
  HERDR_SCHEMA_VERSION,
  isHerdrAgentKind,
  isHerdrAgentAlias,
  isHerdrStartableAgentKind,
  isHerdrSessionName,
  isHerdrSettings,
  normalizeHerdrSettings,
} from "./herdr.ts";

test("Herdr contract is pinned to v0.8.2 protocol 20/schema 1 and all 22 recognized agents", () => {
  assert.equal(HERDR_PROTOCOL_VERSION, 20);
  assert.equal(HERDR_SCHEMA_VERSION, 1);
  assert.equal(HERDR_AGENT_KINDS.length, 22);
  for (const kind of [
    "pi",
    "claude",
    "codex",
    "gemini",
    "omp",
    "opencode",
    "copilot",
    "kimi",
    "droid",
    "grok",
    "qwen",
  ]) {
    assert.equal(isHerdrAgentKind(kind), true);
  }
  assert.equal(isHerdrAgentKind("qwen-code"), false);
  assert.equal(isHerdrAgentKind("shell"), false);
  assert.deepEqual(HERDR_AGENT_KINDS.filter(isHerdrStartableAgentKind), [
    "pi",
    "claude",
    "codex",
    "gemini",
    "omp",
    "opencode",
    "copilot",
    "kimi",
    "droid",
    "grok",
    "qwen",
  ]);
  assert.equal(HERDR_AGENT_PROMPT_MAX_BYTES, 256 * 1024);
  assert.equal(HERDR_AGENT_WAIT_MAX_MS, 120_000);
  assert.equal(HERDR_PANE_READ_MAX_BYTES, 64 * 1024);
  assert.equal(HERDR_AGENT_ALIAS_PATTERN, "^[a-z][a-z0-9_-]{0,63}$");
  for (const alias of ["x", "cu-fake-pi", "agent_1"]) assert.equal(isHerdrAgentAlias(alias), true);
  for (const alias of ["", "CU Fake Pi", "Upper", "-agent", "a".repeat(65)]) {
    assert.equal(isHerdrAgentAlias(alias), false);
  }
});

test("Herdr Session names and settings use exact fail-closed validation", () => {
  assert.equal(isHerdrSettings(DEFAULT_HERDR_SETTINGS), true);
  for (const name of ["default", "pi-desktop", "team_1.test"]) assert.equal(isHerdrSessionName(name), true);
  for (const name of ["", ".", "..", "-other", "../default", "name/child", "line\nbreak", "a".repeat(65)]) {
    assert.equal(isHerdrSessionName(name), false, JSON.stringify(name));
  }
  assert.equal(isHerdrSettings({ ...DEFAULT_HERDR_SETTINGS, unexpected: true }), false);
  assert.equal(isHerdrSettings({ ...DEFAULT_HERDR_SETTINGS, sessionName: "../default" }), false);
  assert.equal(isHerdrSettings({ ...DEFAULT_HERDR_SETTINGS, customExecutable: "bad\npath" }), false);
});

test("legacy binary-source settings migrate to the connection-only Herdr settings contract", () => {
  const migrated = normalizeHerdrSettings({
    ...DEFAULT_HERDR_SETTINGS,
    enabled: true,
    mode: "managed",
    binaryPreference: "custom",
    customExecutable: "/private/herdr",
  });
  assert.deepEqual(migrated, { ...DEFAULT_HERDR_SETTINGS, enabled: true, mode: "managed" });
  assert.equal("binaryPreference" in migrated, false);
  assert.equal("customExecutable" in migrated, false);
});
