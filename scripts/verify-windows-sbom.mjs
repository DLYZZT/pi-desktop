#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { collectWindowsSbomFacts, createWindowsSbom, windowsSbomFile } from "./generate-windows-sbom.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export function verifyWindowsSbom(projectRoot = root) {
  const expectedFile = windowsSbomFile(projectRoot);
  const candidates = fs
    .readdirSync(path.dirname(expectedFile), { withFileTypes: true })
    .filter((entry) => entry.isFile() && /^Pi-Agent-Desktop-Windows-x64-.*\.cdx\.json$/u.test(entry.name));
  assert.equal(candidates.length, 1, "dist must contain exactly one Windows x64 CycloneDX SBOM");
  assert.equal(candidates[0].name, path.basename(expectedFile), "Windows SBOM filename must match package version");
  const source = fs.readFileSync(expectedFile, "utf8");
  assert.equal(source.endsWith("\n"), true, "Windows SBOM must end with one newline");
  const actual = JSON.parse(source);
  const expected = createWindowsSbom(collectWindowsSbomFacts(projectRoot));
  assert.deepEqual(actual, expected, "Windows SBOM does not exactly match the locked release inputs");
  const serialized = JSON.stringify(actual);
  assert.doesNotMatch(serialized, /[A-Za-z]:\\|C:\/Users\/|\/home\//u, "SBOM must not contain local absolute paths");
  const refs = [actual.metadata.component, ...actual.components, ...actual.metadata.tools.components].map(
    (entry) => entry["bom-ref"],
  );
  assert.equal(new Set(refs).size, refs.length, "SBOM bom-ref values must be unique");
  assert.ok(actual.components.length > 800, "Windows production dependency graph is unexpectedly small");
  console.log(
    `[windows-sbom] verified ${path.basename(expectedFile)}: ${actual.components.length} components, ${actual.dependencies.length} dependency records`,
  );
  return actual;
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isMain) {
  try {
    if (process.argv.length !== 2) throw new Error("no arguments are supported");
    verifyWindowsSbom();
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
