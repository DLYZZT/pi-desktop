import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
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

export function createProjectBuildTemp(root, prefix, options = {}) {
  const fileSystem = options.fileSystem ?? fs;
  const temporaryRoot = options.temporaryRoot ?? os.tmpdir();
  const platform = options.platform ?? process.platform;
  const temporaryDirectory = fileSystem.mkdtempSync(path.join(temporaryRoot, prefix));
  try {
    fileSystem.symlinkSync(
      path.join(root, "node_modules"),
      path.join(temporaryDirectory, "node_modules"),
      platform === "win32" ? "junction" : "dir",
    );
    return temporaryDirectory;
  } catch (error) {
    fileSystem.rmSync(temporaryDirectory, { recursive: true, force: true });
    throw error;
  }
}

export function projectNodePath(root, inheritedNodePath = "") {
  return [path.join(root, "node_modules"), inheritedNodePath].filter(Boolean).join(path.delimiter);
}

export function assertSuccessfulSpawn(result, label) {
  if (result.error) throw new Error(`${label} failed to start: ${result.error.message}`);
  if (result.signal) throw new Error(`${label} terminated by signal ${result.signal}`);
  if (!Number.isInteger(result.status)) throw new Error(`${label} returned no exit status`);
  if (result.status !== 0) throw new Error(`${label} exited with status ${result.status}`);
  return result;
}

export function terminateProcessTree(child, options = {}) {
  const pid = child?.pid;
  if (!Number.isInteger(pid) || pid <= 0) return false;
  const platform = options.platform ?? process.platform;
  if (platform === "win32") {
    const result = (options.spawnSync ?? spawnSync)("taskkill", ["/pid", String(pid), "/T", "/F"], {
      stdio: "ignore",
      windowsHide: true,
    });
    if (result.error && result.error.code !== "ESRCH") {
      console.error(`taskkill failed for pid ${pid}: ${result.error.message}`);
    }
    return !result.error && (result.status === 0 || result.status === 128);
  }

  const signal = options.signal ?? "SIGTERM";
  try {
    (options.kill ?? process.kill)(-pid, signal);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") return true;
    try {
      return child.kill(signal);
    } catch {
      return false;
    }
  }
}
