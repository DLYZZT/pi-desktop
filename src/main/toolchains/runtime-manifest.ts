import fs from "node:fs";
import path from "node:path";
import type { RuntimeCatalog, RuntimeCatalogComponent } from "../../shared/toolchains/catalog-schema.ts";
import {
  isManagedComponentId,
  isToolCapabilityId,
  type ManagedComponentId,
  type ToolCapabilityId,
} from "../../shared/toolchains/types.ts";
import { hashFile } from "./downloader.ts";
import type { ExecutableSeed } from "./discovery-registry.ts";
import { normalizeArchiveEntryPath } from "./secure-extractor.ts";
import type { ToolchainPaths } from "./paths.ts";
import { runtimeDirectory, runtimeManifestPath } from "./paths.ts";
import type { ToolchainPersistentState } from "./state-store.ts";

export const RUNTIME_MANIFEST_SCHEMA_VERSION = 1 as const;

export interface RuntimeManifest {
  schemaVersion: typeof RUNTIME_MANIFEST_SCHEMA_VERSION;
  componentId: ManagedComponentId;
  version: string;
  platformArch: string;
  catalogRevision: number;
  artifactSha256: string;
  installedAt: string;
  entrypoints: Array<{ capability: ToolCapabilityId; path: string }>;
  keyFiles: Array<{ path: string; sha256: string }>;
}

const COMPONENT_ENTRYPOINT_CAPABILITIES: Readonly<Record<ManagedComponentId, readonly ToolCapabilityId[]>> = {
  "portable-git": ["vcs.git", "shell.bash"],
  "node-lts": ["js.node"],
  cpython: ["python.interpreter"],
  uv: ["python.uv"],
  ripgrep: ["search.rg"],
  fd: ["search.fd"],
  jq: ["data.jq"],
  bun: ["js.bun"],
};

function relativeRuntimePath(runtimeRoot: string, filePath: string): string {
  const relative = path.relative(runtimeRoot, filePath).split(path.sep).join("/");
  return normalizeArchiveEntryPath(relative);
}

function absoluteRuntimePath(runtimeRoot: string, relativePath: string): string {
  const normalized = normalizeArchiveEntryPath(relativePath);
  const target = path.resolve(runtimeRoot, ...normalized.split("/"));
  if (!target.startsWith(`${path.resolve(runtimeRoot)}${path.sep}`))
    throw new Error("Runtime manifest path escapes root");
  return target;
}

function parseManifest(value: unknown): RuntimeManifest {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid runtime manifest");
  const manifest = value as RuntimeManifest;
  if (
    manifest.schemaVersion !== RUNTIME_MANIFEST_SCHEMA_VERSION ||
    !isManagedComponentId(manifest.componentId) ||
    typeof manifest.version !== "string" ||
    !/^[0-9A-Za-z][0-9A-Za-z.+_-]{0,127}$/.test(manifest.version) ||
    manifest.version.includes("..") ||
    typeof manifest.platformArch !== "string" ||
    !/^(?:darwin|win32|linux)-(?:x64|arm64)$/.test(manifest.platformArch) ||
    !Number.isSafeInteger(manifest.catalogRevision) ||
    !/^[a-f0-9]{64}$/.test(manifest.artifactSha256) ||
    typeof manifest.installedAt !== "string" ||
    !Array.isArray(manifest.entrypoints) ||
    !Array.isArray(manifest.keyFiles)
  ) {
    throw new Error("Invalid runtime manifest fields");
  }
  for (const entry of manifest.entrypoints) {
    if (
      !entry ||
      !isToolCapabilityId(entry.capability) ||
      !COMPONENT_ENTRYPOINT_CAPABILITIES[manifest.componentId].includes(entry.capability) ||
      typeof entry.path !== "string"
    ) {
      throw new Error("Invalid runtime entrypoint");
    }
    normalizeArchiveEntryPath(entry.path);
  }
  if (new Set(manifest.entrypoints.map((entry) => entry.capability)).size !== manifest.entrypoints.length) {
    throw new Error("Duplicate runtime entrypoint capability");
  }
  for (const file of manifest.keyFiles) {
    if (!file || typeof file.path !== "string" || !/^[a-f0-9]{64}$/.test(file.sha256)) {
      throw new Error("Invalid runtime key file");
    }
    normalizeArchiveEntryPath(file.path);
  }
  return manifest;
}

export async function writeRuntimeManifest(options: {
  runtimeRoot: string;
  component: RuntimeCatalogComponent;
  platformArch: string;
  catalogRevision: number;
  artifactSha256: string;
  entrypoint?: { capability: ToolCapabilityId; executable: string };
  entrypoints?: Array<{ capability: ToolCapabilityId; executable: string }>;
  keyFiles: string[];
  installedAt: string;
}): Promise<RuntimeManifest> {
  const entrypoints = options.entrypoints ?? (options.entrypoint ? [options.entrypoint] : []);
  if (entrypoints.length === 0) throw new Error("Runtime manifest requires at least one entrypoint");
  const uniqueFiles = [...new Set([...entrypoints.map((entrypoint) => entrypoint.executable), ...options.keyFiles])];
  const keyFiles = await Promise.all(
    uniqueFiles.map(async (filePath) => ({
      path: relativeRuntimePath(options.runtimeRoot, filePath),
      sha256: (await hashFile(filePath)).sha256,
    })),
  );
  const manifest: RuntimeManifest = {
    schemaVersion: RUNTIME_MANIFEST_SCHEMA_VERSION,
    componentId: options.component.id,
    version: options.component.version,
    platformArch: options.platformArch,
    catalogRevision: options.catalogRevision,
    artifactSha256: options.artifactSha256,
    installedAt: options.installedAt,
    entrypoints: entrypoints.map((entrypoint) => ({
      capability: entrypoint.capability,
      path: relativeRuntimePath(options.runtimeRoot, entrypoint.executable),
    })),
    keyFiles,
  };
  fs.writeFileSync(runtimeManifestPath(options.runtimeRoot), `${JSON.stringify(manifest, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  return manifest;
}

export async function verifyRuntimeManifest(options: {
  runtimeRoot: string;
  component: RuntimeCatalogComponent;
  platformArch: string;
}): Promise<RuntimeManifest | undefined> {
  const manifest = await verifyInstalledRuntimeManifest({
    runtimeRoot: options.runtimeRoot,
    componentId: options.component.id,
    version: options.component.version,
    platformArch: options.platformArch,
  });
  if (
    !manifest ||
    manifest.entrypoints.some((entrypoint) => !options.component.provides.includes(entrypoint.capability))
  ) {
    return undefined;
  }
  return manifest;
}

export async function verifyInstalledRuntimeManifest(options: {
  runtimeRoot: string;
  componentId: ManagedComponentId;
  version: string;
  platformArch: string;
}): Promise<RuntimeManifest | undefined> {
  try {
    const manifestPath = runtimeManifestPath(options.runtimeRoot);
    const raw = fs.readFileSync(manifestPath, "utf8");
    if (Buffer.byteLength(raw) > 1024 * 1024) return undefined;
    const manifest = parseManifest(JSON.parse(raw));
    if (
      manifest.componentId !== options.componentId ||
      manifest.version !== options.version ||
      manifest.platformArch !== options.platformArch
    ) {
      return undefined;
    }
    if (manifest.entrypoints.length === 0) {
      return undefined;
    }
    for (const file of manifest.keyFiles) {
      const absolute = absoluteRuntimePath(options.runtimeRoot, file.path);
      const real = fs.realpathSync.native(absolute);
      if (!real.startsWith(`${fs.realpathSync.native(options.runtimeRoot)}${path.sep}`)) return undefined;
      if ((await hashFile(absolute)).sha256 !== file.sha256) return undefined;
    }
    return manifest;
  } catch {
    return undefined;
  }
}

export async function managedSeedsFromState(options: {
  paths: ToolchainPaths;
  state: ToolchainPersistentState;
  catalog: RuntimeCatalog;
  platform: NodeJS.Platform;
  arch: string;
}): Promise<ExecutableSeed[]> {
  const seeds: ExecutableSeed[] = [];
  const platformArch = `${options.platform}-${options.arch}`;
  for (const [componentId, activation] of Object.entries(options.state.managed) as Array<
    [ManagedComponentId, NonNullable<ToolchainPersistentState["managed"][ManagedComponentId]>]
  >) {
    if (!activation || activation.platformArch !== platformArch) continue;
    const installedVersions = [...new Set([activation.activeVersion, ...activation.installedVersions])];
    for (const [versionIndex, version] of installedVersions.entries()) {
      const component = options.catalog.components.find(
        (entry) => entry.id === componentId && entry.version === version,
      );
      const runtimeRoot = runtimeDirectory(options.paths, componentId, version, options.platform, options.arch);
      const manifest = component
        ? await verifyRuntimeManifest({ runtimeRoot, component, platformArch })
        : await verifyInstalledRuntimeManifest({ runtimeRoot, componentId, version, platformArch });
      if (!manifest) continue;
      for (const entrypoint of manifest.entrypoints) {
        const executable = absoluteRuntimePath(runtimeRoot, entrypoint.path);
        seeds.push({
          capability: entrypoint.capability,
          provider: "managed",
          discovery: `managed:${componentId}:${version}`,
          executable,
          argvPrefix: [],
          binDir: path.dirname(executable),
          componentId,
          componentRoot: runtimeRoot,
          rank: version === activation.activeVersion ? 5_000 : 5_100 + versionIndex,
        });
      }
    }
  }
  return seeds;
}
