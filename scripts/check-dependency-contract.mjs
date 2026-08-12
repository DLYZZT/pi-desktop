#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const expectedNodeMajor = 22;
const expectedNodeTypes = "22.19.0";
const expectedBuildEsbuild = "0.27.7";

export function validateDependencyManifest(packageJson) {
  const failures = [];
  if (packageJson.private !== true) failures.push('package.json must set "private": true');
  if (packageJson.engines?.node !== ">=22.19.0 <23") failures.push("Node engine must be bounded to supported Node 22");
  if (packageJson.devDependencies?.["@types/node"] !== expectedNodeTypes)
    failures.push(`@types/node must be exactly ${expectedNodeTypes}`);
  if (packageJson.devDependencies?.esbuild !== expectedBuildEsbuild)
    failures.push(`top-level esbuild must be exactly ${expectedBuildEsbuild}`);
  return failures;
}

export function validateEsbuildTree(tree) {
  const failures = [];
  const rootVersion = tree.dependencies?.esbuild?.version;
  const tsupVersion = tree.dependencies?.tsup?.dependencies?.esbuild?.version ?? rootVersion;
  const bundleRequireVersion =
    tree.dependencies?.tsup?.dependencies?.["bundle-require"]?.dependencies?.esbuild?.version ?? rootVersion;
  for (const [owner, version] of [
    ["root", rootVersion],
    ["tsup", tsupVersion],
    ["bundle-require", bundleRequireVersion],
  ]) {
    if (version !== expectedBuildEsbuild) failures.push(`${owner} build esbuild resolved to ${version ?? "missing"}`);
  }
  return failures;
}

function main() {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const packageJson = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  const failures = validateDependencyManifest(packageJson);
  const runtimeMajor = Number(process.versions.node.split(".")[0]);
  if (runtimeMajor !== expectedNodeMajor)
    failures.push(`dependency checks must run on Node 22, received ${process.version}`);

  const npmTree = spawnSync("npm", ["ls", "esbuild", "--all", "--json"], {
    cwd: root,
    encoding: "utf8",
    shell: false,
  });
  if (npmTree.error) failures.push(`npm ls esbuild failed to start: ${npmTree.error.message}`);
  else if (npmTree.signal) failures.push(`npm ls esbuild terminated by signal ${npmTree.signal}`);
  else if (npmTree.status !== 0)
    failures.push(`npm ls esbuild exited with status ${npmTree.status}: ${npmTree.stderr.trim()}`);
  else {
    try {
      failures.push(...validateEsbuildTree(JSON.parse(npmTree.stdout)));
    } catch (error) {
      failures.push(`npm ls esbuild returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  if (failures.length > 0) {
    for (const failure of failures) console.error(`FAIL: ${failure}`);
    process.exitCode = 1;
    return;
  }
  console.log(
    `Dependency contract OK: Node 22, @types/node ${expectedNodeTypes}, build esbuild ${expectedBuildEsbuild}`,
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
