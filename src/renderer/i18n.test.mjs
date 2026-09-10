import assert from "node:assert/strict";
import test from "node:test";

test("startup and language changes synchronize native UI and preserve renderer preference", async (t) => {
  const patches = [];
  let saved = "zh-TW";
  globalThis.window = {
    navigator: { language: "en-US" },
    localStorage: { getItem: () => saved, setItem: (_key, value) => (saved = value) },
    piBridge: { setUiState: async (patch) => patches.push(patch) },
  };
  globalThis.document = { documentElement: { lang: "" } };
  t.after(() => {
    delete globalThis.window;
    delete globalThis.document;
  });
  const { setAppLanguage, translate } = await import("./i18n.ts?native-sync");
  assert.equal(globalThis.document.documentElement.lang, "zh-TW");
  assert.equal(translate("settings", "Settings"), "設定");
  assert.deepEqual(patches, [{ language: "zh-TW" }]);
  setAppLanguage("en-US");
  setAppLanguage("zh-CN");
  setAppLanguage("zh-TW");
  assert.equal(saved, "zh-TW");
  assert.deepEqual(
    patches.map(({ language }) => language),
    ["zh-TW", "en-US", "zh-CN", "zh-TW"],
  );
  // Unavailable browser persistence must not prevent native synchronization.
  globalThis.window.localStorage.setItem = () => {
    throw new Error("storage unavailable");
  };
  setAppLanguage("en-US");
  assert.equal(translate("settings", "Settings"), "Settings");
  assert.equal(patches.at(-1).language, "en-US");
});

test("native synchronization failure is handled without losing the renderer language", async (t) => {
  const warnings = [];
  t.mock.method(console, "warn", (...args) => warnings.push(args));
  globalThis.window = {
    navigator: { language: "zh-TW" },
    localStorage: { getItem: () => null, setItem: () => {} },
    piBridge: {
      setUiState: async () => {
        throw new Error("disk unavailable");
      },
    },
  };
  t.after(() => {
    delete globalThis.window;
  });
  const { translate } = await import("./i18n.ts?native-failure");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(translate("settings", "Settings"), "設定");
  assert.equal(warnings.length, 1);
});
