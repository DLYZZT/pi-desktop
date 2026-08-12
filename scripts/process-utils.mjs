import { createRequire } from "node:module";
import path from "node:path";

export function createProjectRequire(root) {
  return createRequire(path.join(root, "package.json"));
}

export function resolvePackageFile(root, packageName, relativePath) {
  const projectRequire = createProjectRequire(root);
  const packageRoot = path.dirname(projectRequire.resolve(`${packageName}/package.json`));
  return path.join(packageRoot, relativePath);
}

export function resolveElectronBinary(root) {
  const value = createProjectRequire(root)("electron");
  if (typeof value !== "string" || value.length === 0)
    throw new Error("electron package did not resolve an executable");
  return value;
}

export function assertSuccessfulSpawn(result, label) {
  if (result.error) throw new Error(`${label} failed to start: ${result.error.message}`);
  if (result.signal) throw new Error(`${label} terminated by signal ${result.signal}`);
  if (!Number.isInteger(result.status)) throw new Error(`${label} returned no exit status`);
  if (result.status !== 0) throw new Error(`${label} exited with status ${result.status}`);
  return result;
}
