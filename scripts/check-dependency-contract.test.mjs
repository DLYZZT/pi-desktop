import assert from "node:assert/strict";
import test from "node:test";

import { validateDependencyManifest, validateEsbuildTree } from "./check-dependency-contract.mjs";

const validManifest = {
  private: true,
  engines: { node: ">=22.19.0 <23" },
  devDependencies: { "@types/node": "22.19.0", esbuild: "0.27.7" },
};

test("dependency manifest pins the supported Node and build toolchain", () => {
  assert.deepEqual(validateDependencyManifest(validManifest), []);
  const invalid = structuredClone(validManifest);
  invalid.private = false;
  invalid.engines.node = ">=22";
  invalid.devDependencies["@types/node"] = "^25";
  invalid.devDependencies.esbuild = "^0.27.7";
  assert.deepEqual(validateDependencyManifest(invalid), [
    'package.json must set "private": true',
    "Node engine must be bounded to supported Node 22",
    "@types/node must be exactly 22.19.0",
    "top-level esbuild must be exactly 0.27.7",
  ]);
});

test("tsup and bundle-require share the exact top-level esbuild", () => {
  assert.deepEqual(
    validateEsbuildTree({
      dependencies: {
        esbuild: { version: "0.27.7" },
        tsup: {
          dependencies: {
            esbuild: { version: "0.27.7" },
            "bundle-require": { dependencies: { esbuild: { version: "0.27.7" } } },
          },
        },
      },
    }),
    [],
  );
  assert.deepEqual(
    validateEsbuildTree({
      dependencies: {
        esbuild: { version: "0.27.8" },
        tsup: { dependencies: { esbuild: { version: "0.27.6" } } },
      },
    }),
    [
      "root build esbuild resolved to 0.27.8",
      "tsup build esbuild resolved to 0.27.6",
      "bundle-require build esbuild resolved to 0.27.8",
    ],
  );
});
