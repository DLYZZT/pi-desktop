import path from "node:path";
import type { ManagedComponentId, ToolchainCacheId } from "../../shared/toolchains/types.ts";

export interface ToolchainPaths {
  root: string;
  stateFile: string;
  stateBackupFile: string;
  locks: string;
  downloads: string;
  staging: string;
  runtimes: string;
  caches: Record<ToolchainCacheId, string>;
  prefixes: { npm: string; uvTools: string };
  bin: string;
  shims: string;
  logs: string;
  diagnostics: string;
}

export function createToolchainPaths(userDataRoot: string): ToolchainPaths {
  if (!path.isAbsolute(userDataRoot)) throw new Error("Toolchain userData root must be absolute");
  const root = path.join(userDataRoot, "toolchains");
  return {
    root,
    stateFile: path.join(root, "state.json"),
    stateBackupFile: path.join(root, "state.json.bak"),
    locks: path.join(root, "locks"),
    downloads: path.join(root, "downloads"),
    staging: path.join(root, "staging"),
    runtimes: path.join(root, "runtimes"),
    caches: {
      npm: path.join(root, "caches", "npm"),
      uv: path.join(root, "caches", "uv"),
      bun: path.join(root, "caches", "bun"),
      downloads: path.join(root, "downloads"),
    },
    prefixes: {
      npm: path.join(root, "prefixes", "npm"),
      uvTools: path.join(root, "prefixes", "uv-tools"),
    },
    bin: path.join(root, "bin"),
    shims: path.join(root, "shims"),
    logs: path.join(root, "logs"),
    diagnostics: path.join(root, "diagnostics"),
  };
}

export function runtimeDirectory(
  paths: ToolchainPaths,
  componentId: ManagedComponentId,
  version: string,
  platform: NodeJS.Platform,
  arch: string,
): string {
  if (!/^[0-9A-Za-z][0-9A-Za-z.+_-]{0,127}$/.test(version) || version.includes("..")) {
    throw new Error("Unsafe managed component version");
  }
  if (!/^[a-z0-9_-]{1,32}$/i.test(arch)) throw new Error("Unsafe managed component architecture");
  return path.join(paths.runtimes, componentId, version, `${platform}-${arch}`);
}

export function runtimeManifestPath(runtimeRoot: string): string {
  return path.join(runtimeRoot, "runtime-manifest.json");
}
