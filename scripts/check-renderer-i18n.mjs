#!/usr/bin/env node
import path from "node:path";
import { fileURLToPath } from "node:url";
import { checkRendererI18n } from "./renderer-i18n-checker.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const rendererRoot = path.join(root, "src/renderer");
const dictionariesPath = path.join(rendererRoot, "i18n-dictionaries.ts");
const { failures, keyCount } = checkRendererI18n({ root, rendererRoot, dictionariesPath });

if (failures.length) {
  console.error(`[renderer-i18n] ${failures.length} invariant(s) failed`);
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}
console.log(
  `[renderer-i18n] ${keyCount} static keys have en-US/zh-CN parity, registered fallbacks, and guarded user-facing literals`,
);
