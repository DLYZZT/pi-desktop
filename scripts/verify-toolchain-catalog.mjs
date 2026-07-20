#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseRuntimeCatalog } from "../src/shared/toolchains/catalog-schema.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const catalogPaths = ["runtime-catalog.json", "core-catalog.json"].map((name) =>
  path.join(root, "build", "toolchains", name),
);
const [catalog, coreCatalog] = catalogPaths.map((catalogPath) =>
  parseRuntimeCatalog(JSON.parse(fs.readFileSync(catalogPath, "utf8"))),
);
const releasedVariants = ["darwin-arm64", "darwin-x64", "win32-x64", "linux-x64"];
const failures = [];

function requireVariants(source, componentId, requiredVariants) {
  const components = source.components.filter((entry) => entry.id === componentId);
  if (components.length === 0) {
    failures.push(`missing catalog component: ${componentId}`);
    return;
  }
  const variants = new Set(
    components.flatMap((component) => component.variants.map((entry) => `${entry.platform}-${entry.arch}`)),
  );
  for (const variant of requiredVariants) {
    if (!variants.has(variant)) failures.push(`${componentId} is missing ${variant}`);
  }
}

for (const componentId of ["node-lts", "cpython", "uv", "jq", "bun"]) {
  requireVariants(catalog, componentId, releasedVariants);
}
requireVariants(catalog, "portable-git", ["win32-x64"]);
for (const componentId of ["ripgrep", "fd"]) requireVariants(coreCatalog, componentId, releasedVariants);

if (coreCatalog.components.some((component) => component.id !== "ripgrep" && component.id !== "fd")) {
  failures.push("core catalog may contain only bundled ripgrep and fd");
}

for (const component of [...catalog.components, ...coreCatalog.components]) {
  for (const variant of component.variants) {
    if (/\/latest(?:\/|-)|releases\/latest/i.test(variant.url)) {
      failures.push(`${component.id} uses a mutable latest URL`);
    }
    if (variant.sha256 === "0".repeat(64)) failures.push(`${component.id} uses an empty checksum`);
  }
}

if (failures.length > 0) {
  for (const failure of failures) console.error(`FAIL: ${failure}`);
  process.exit(1);
}

console.log(
  `OK: managed catalog revision ${catalog.revision} and core catalog revision ${coreCatalog.revision} validate ${catalog.components.length + coreCatalog.components.length} fixed components across ${[...catalog.components, ...coreCatalog.components].reduce((sum, component) => sum + component.variants.length, 0)} variants`,
);
