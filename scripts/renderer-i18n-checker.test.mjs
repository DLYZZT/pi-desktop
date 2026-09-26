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

function domainFixture(t, part = 'export const enUS = {greeting: "Hello"}; export const zhCN = {greeting: "你好"};') {
  const entry = fixture(
    't("greeting", "Hello");',
    `
    import {mergeDictionaries} from "./i18n/merge-dictionaries.ts";
    import {enUS as commonEn, zhCN as commonZh} from "./i18n/common.ts";
    export const enUS = mergeDictionaries(commonEn);
    export const zhCN = mergeDictionaries(commonZh);
  `,
  );
  t.after(entry.cleanup);
  const directory = path.join(entry.options.rendererRoot, "i18n");
  fs.mkdirSync(directory);
  fs.writeFileSync(path.join(directory, "common.ts"), part);
  return {
    ...entry,
    write(name, content) {
      fs.writeFileSync(path.join(directory, name), content);
    },
  };
}

test("follows explicit domain imports and preserves all existing parity and fallback checks", (t) => {
  const entry = domainFixture(t);
  assert.deepEqual(checkRendererI18n(entry.options), { failures: [], keyCount: 1 });
  entry.write("common.ts", 'export const enUS = {greeting: "Drift {name}"}; export const zhCN = {};');
  const errors = checkRendererI18n(entry.options).failures.join("\n");
  assert.match(errors, /zh-CN is missing greeting/);
  assert.match(errors, /fallback .* does not match/);
});

test("rejects cross-domain duplicates even when the overridden translations are identical", (t) => {
  const entry = domainFixture(
    t,
    `
    import {mergeDictionaries} from "./merge-dictionaries.ts";
    import {one, two} from "./parts.ts";
    export const enUS = mergeDictionaries(one, two);
    export const zhCN = {greeting: "你好"};
  `,
  );
  entry.write("parts.ts", 'export const one = {greeting: "Hello"}; export const two = {greeting: "Hello"};');
  assert.match(checkRendererI18n(entry.options).failures.join("\n"), /enUS contains duplicate key greeting/);
});

test("unknown composition, missing domain modules, cycles and dynamic entries cannot silently pass", (t) => {
  const entry = domainFixture(t);
  for (const [source, expected] of [
    ["export const enUS = load(); export const zhCN = {};", /non-static dictionary composition/],
    [
      'import {enUS as other} from "./absent.ts"; export const enUS = other; export const zhCN = {};',
      /module not found/,
    ],
    ["export const enUS = alias; const alias = enUS; export const zhCN = {};", /cyclic import/],
    ["export const enUS = {greeting: compute()}; export const zhCN = {};", /non-static dictionary entry/],
    ["export const enUS = {...other}; export const zhCN = {};", /non-static dictionary entry/],
  ]) {
    entry.write("common.ts", source);
    assert.match(checkRendererI18n(entry.options).failures.join("\n"), expected);
  }
});

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

test("enforces parity for every registered localized dictionary", () => {
  const entry = fixture(
    'export const value = t("greeting", "Hello {name}");',
    'export const enUS = { greeting: "Hello {name}" }; export const zhCN = { greeting: "你好 {name}" }; export const zhTW = { other: "其他" };',
  );
  try {
    const output = checkRendererI18n({
      ...entry.options,
      localizedDictionaries: [
        { name: "zhCN", tag: "zh-CN" },
        { name: "zhTW", tag: "zh-TW" },
      ],
    }).failures.join("\n");
    assert.match(output, /zh-TW is missing greeting/);
    assert.match(output, /en-US is missing other/);
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

test("model hook extraction preserves the localized-notification boundary", (t) => {
  const entry = fixture(
    'addNotice({ type: "warning", message: "Model directory failed" });',
    "export const enUS = {}; export const zhCN = {};",
    "hooks/useSessionModels.ts",
  );
  t.after(entry.cleanup);
  assert.match(
    checkRendererI18n(entry.options).failures.join("\n"),
    /hardcoded session message: Model directory failed/,
  );
});

test("history hook extraction preserves localized load errors", (t) => {
  const entry = fixture(
    'setError("History unavailable");',
    "export const enUS = {}; export const zhCN = {};",
    "hooks/useSessionHistory.ts",
  );
  t.after(entry.cleanup);
  assert.match(checkRendererI18n(entry.options).failures.join("\n"), /hardcoded session error: History unavailable/);
});

test("extension UI hook retains the localized notification boundary", (t) => {
  const entry = fixture(
    'addNotice({message: "Extension request failed"});',
    "export const enUS = {}; export const zhCN = {};",
    "hooks/useSessionExtensionUi.ts",
  );
  t.after(entry.cleanup);
  assert.match(
    checkRendererI18n(entry.options).failures.join("\n"),
    /hardcoded session message: Extension request failed/,
  );
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
