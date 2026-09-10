import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { importTestBundle } from "#test-bundle";

test("native UI reads persisted language on restart and subsequent changes", async (t) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "pi-native-language-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const { getNativeLanguage } = await importTestBundle("native-language", {
    entryPoints: [new URL("./native-language.ts", import.meta.url).pathname],
    plugins: [
      {
        name: "electron-language",
        setup(build) {
          build.onResolve({ filter: /^electron$/ }, () => ({ path: "electron", namespace: "native-language-test" }));
          build.onLoad({ filter: /.*/, namespace: "native-language-test" }, () => ({
            contents: `export const app = { getPath: () => ${JSON.stringify(directory)}, getLocale: () => "en-US" };`,
          }));
        },
      },
    ],
  });
  assert.equal(getNativeLanguage(), "en-US");
  for (const language of ["zh-TW", "zh-CN", "en-US"]) {
    writeFileSync(path.join(directory, "ui-state.json"), JSON.stringify({ language }));
    assert.equal(getNativeLanguage(), language);
  }
  writeFileSync(path.join(directory, "ui-state.json"), '{"language":{}}');
  assert.equal(getNativeLanguage(), "en-US");
});
