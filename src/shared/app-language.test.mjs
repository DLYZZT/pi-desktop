import assert from "node:assert/strict";
import test from "node:test";
import { isAppLanguage, resolveAppLanguage } from "./app-language.ts";

test("explicit app language wins over system locale and malformed preferences fall back", () => {
  for (const language of ["en-US", "zh-CN", "zh-TW"]) {
    assert.equal(isAppLanguage(language), true);
    assert.equal(resolveAppLanguage(language, "ja-JP"), language);
  }
  for (const invalid of [undefined, null, {}, "zh-HK", "fr-FR", 1]) {
    assert.equal(isAppLanguage(invalid), false);
    assert.equal(resolveAppLanguage(invalid, "zh-HK"), "zh-TW");
  }
});

test("Chinese locale detection respects explicit script before region", () => {
  for (const locale of ["zh-TW", "zh-HK", "zh-MO", "zh-Hant", "zh-Hant-CN", "zh_TW"]) {
    assert.equal(resolveAppLanguage(undefined, locale), "zh-TW", locale);
  }
  for (const locale of ["zh", "zh-CN", "zh-SG", "zh-Hans", "zh-Hans-HK"]) {
    assert.equal(resolveAppLanguage(undefined, locale), "zh-CN", locale);
  }
  for (const locale of ["en-US", "ja-JP", "", "mo", "tw"]) {
    assert.equal(resolveAppLanguage(undefined, locale), "en-US", locale);
  }
});
