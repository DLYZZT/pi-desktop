import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const skillsSource = readFileSync(new URL("./SkillsConfig.tsx", import.meta.url), "utf8");
const settingsSource = readFileSync(new URL("./SettingsConfig.tsx", import.meta.url), "utf8");

test("SkillDetail exposes dirty state and a fallible save operation", () => {
  assert.match(skillsSource, /hasUnsavedChanges: \(\) => content !== savedContent/);
  assert.match(skillsSource, /save: saveContent/);
  assert.match(skillsSource, /const saveContent = useCallback\(async \(\): Promise<boolean>/);
  assert.match(skillsSource, /setSavedContent\(content\);\s*onSaved\(\);\s*return true/);
  assert.match(skillsSource, /catch \(error\) \{[\s\S]*?setContentError[\s\S]*?return false/);
});

test("SkillsConfig gates switching, adding, closing, and reload", () => {
  assert.match(skillsSource, /requestLeave: requestTransition/);
  assert.match(skillsSource, /requestTransition\(\(\) => \{\s*setSelected\(skill\.filePath\)/);
  assert.match(skillsSource, /requestTransition\(\(\) => setAddMode\(true\)\)/);
  assert.equal((skillsSource.match(/requestTransition\(onClose\)/g) ?? []).length >= 3, true);
  assert.match(skillsSource, /window\.addEventListener\("beforeunload", preventReload\)/);
});

test("the unsaved prompt offers save, discard, and cancel", () => {
  assert.match(skillsSource, /onClick=\{discardAndContinue\}/);
  assert.match(skillsSource, /onClick=\{\(\) => setPendingTransition\(null\)\}/);
  assert.match(skillsSource, /onClick=\{\(\) => void saveAndContinue\(\)\}/);
  assert.match(skillsSource, /if \(!saved\) return/);
});

test("Settings routes every close and tab transition through SkillsConfig", () => {
  assert.match(settingsSource, /skillsConfigRef\.current\.requestLeave\(action\)/);
  assert.match(settingsSource, /event\.target === event\.currentTarget\) requestSettingsTransition\(onClose\)/);
  assert.match(settingsSource, /event\.key === "Escape"[\s\S]*?requestSettingsTransition\(onClose\)/);
  assert.match(settingsSource, /onClick=\{\(\) => requestSettingsTransition\(onClose\)\}/);
  assert.match(settingsSource, /if \(!active\) requestSettingsTransition\(\(\) => setActiveTab\(tab\.id\)\)/);
  assert.match(settingsSource, /<SkillsConfig ref=\{skillsConfigRef\}/);
});
