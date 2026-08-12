#!/usr/bin/env node
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runTests } from "./test-runner.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
try {
  runTests(root);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
