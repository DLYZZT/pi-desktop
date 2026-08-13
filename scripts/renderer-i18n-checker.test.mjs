import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { checkRendererI18n } from "./renderer-i18n-checker.mjs";

function fixture(component, dictionaries, componentPath = "Component.tsx") {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-renderer-i18n-"));
  const rendererRoot = path.join(root, "src/renderer");
  const dictionariesPath = path.join(rendererRoot, "i18n-dictionaries.ts");
  fs.mkdirSync(rendererRoot, { recursive: true });
  const target = path.join(rendererRoot, componentPath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, component);
  fs.writeFileSync(dictionariesPath, dictionaries);
  return {
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
    options: { root, rendererRoot, dictionariesPath },
  };
}

test("accepts static calls with exact bilingual dictionary and placeholder parity", () => {
  const entry = fixture(
    'export const value = t("greeting", "Hello {name}");',
    'export const enUS = { greeting: "Hello {name}" }; export const zhCN = { greeting: "你好 {name}" };',
  );
  try {
    assert.deepEqual(checkRendererI18n(entry.options), { failures: [], keyCount: 1 });
  } finally {
    entry.cleanup();
  }
});

test("rejects visible literals and hardcoded session notification sinks in migrated owners", () => {
  const component = fixture(
    'export function AppShell() { return <button aria-label="Open panel">Open panel</button>; }',
    "export const enUS = {}; export const zhCN = {};",
    "components/AppShell.tsx",
  );
  const hook = fixture(
    'addNotice({ type: "error", message: "Queue failed" }); complete({ handled: true, error: "No session" });',
    "export const enUS = {}; export const zhCN = {};",
    "hooks/useAgentSession.ts",
  );
  try {
    const componentOutput = checkRendererI18n(component.options).failures.join("\n");
    assert.match(componentOutput, /visible English JSX literal: Open panel/);
    const hookOutput = checkRendererI18n(hook.options).failures.join("\n");
    assert.match(hookOutput, /hardcoded session message: Queue failed/);
    assert.match(hookOutput, /hardcoded session error: No session/);
  } finally {
    component.cleanup();
    hook.cleanup();
  }
});

test("rejects dynamic calls, fallback drift, missing and duplicate entries, orphan keys, and placeholder mismatch", () => {
  const entry = fixture(
    `
      const dynamicKey = "dynamic";
      t(dynamicKey, "Dynamic");
      t("fallback", "Source fallback");
      t("missing", "Missing");
      t("inconsistent", "First");
      t("inconsistent", "Second");
    `,
    `
      export const enUS = {
        fallback: "Registered fallback",
        inconsistent: "First",
        duplicate: "one",
        duplicate: "two",
        orphan: "Orphan",
        placeholder: "Hello {name}",
      };
      export const zhCN = {
        fallback: "回退",
        inconsistent: "第一",
        duplicate: "重复",
        orphan: "孤儿",
        placeholder: "你好",
      };
    `,
  );
  try {
    const { failures } = checkRendererI18n(entry.options);
    const output = failures.join("\n");
    assert.match(output, /dynamic translation key or fallback/);
    assert.match(output, /fallback.*does not match the registered en-US value/);
    assert.match(output, /zh-CN is missing missing/);
    assert.match(output, /enUS contains duplicate key duplicate/);
    assert.match(output, /inconsistent uses inconsistent fallbacks/);
    assert.match(output, /dictionary key orphan has no static Renderer translation call/);
    assert.match(output, /placeholder placeholder mismatch/);
  } finally {
    entry.cleanup();
  }
});
