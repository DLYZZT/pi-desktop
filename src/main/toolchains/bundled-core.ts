import fs from "node:fs";
import path from "node:path";
import type { RuntimeCatalog } from "../../shared/toolchains/catalog-schema.ts";
import { isManagedComponentId, isToolCapabilityId } from "../../shared/toolchains/types.ts";
import { hashFile } from "./downloader.ts";
import type { DiscoveryFileSystem, ExecutableSeed } from "./discovery-registry.ts";
import { nodeDiscoveryFileSystem } from "./discovery-registry.ts";

interface BundledToolManifestEntry {
  componentId: "ripgrep" | "fd";
  capability: "search.rg" | "search.fd";
  version: string;
  executable: string;
  sha256: string;
  bytes: number;
  artifactSha256: string;
}

interface BundledLicenseManifestEntry {
  componentId: "ripgrep" | "fd";
  path: string;
  sourceUrl: string;
  sha256: string;
}

interface BundledCoreManifest {
  schemaVersion: 1;
  catalogRevision: number;
  platform: string;
  arch: string;
  tools: BundledToolManifestEntry[];
  licenses: BundledLicenseManifestEntry[];
}

function isSha256(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

function safeRelativePath(value: unknown): string | undefined {
  if (typeof value !== "string" || !value || value.includes("\0") || value.includes("\\") || path.isAbsolute(value)) {
    return undefined;
  }
  const normalized = path.posix.normalize(value);
  if (normalized === "." || normalized === ".." || normalized.startsWith("../")) return undefined;
  return normalized;
}

function parseManifest(value: unknown): BundledCoreManifest | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const manifest = value as Partial<BundledCoreManifest>;
  if (
    manifest.schemaVersion !== 1 ||
    !Number.isSafeInteger(manifest.catalogRevision) ||
    typeof manifest.platform !== "string" ||
    typeof manifest.arch !== "string" ||
    !Array.isArray(manifest.tools) ||
    !Array.isArray(manifest.licenses)
  ) {
    return undefined;
  }
  for (const tool of manifest.tools) {
    if (
      !tool ||
      !isManagedComponentId(tool.componentId) ||
      !["ripgrep", "fd"].includes(tool.componentId) ||
      !isToolCapabilityId(tool.capability) ||
      !["search.rg", "search.fd"].includes(tool.capability) ||
      typeof tool.version !== "string" ||
      !safeRelativePath(tool.executable) ||
      !isSha256(tool.sha256) ||
      !Number.isSafeInteger(tool.bytes) ||
      tool.bytes <= 0 ||
      !isSha256(tool.artifactSha256)
    ) {
      return undefined;
    }
  }
  for (const license of manifest.licenses) {
    if (
      !license ||
      !["ripgrep", "fd"].includes(license.componentId) ||
      !safeRelativePath(license.path) ||
      typeof license.sourceUrl !== "string" ||
      !license.sourceUrl.startsWith("https://") ||
      !isSha256(license.sha256)
    ) {
      return undefined;
    }
  }
  return manifest as BundledCoreManifest;
}

function absoluteManifestPath(root: string, relative: string): string | undefined {
  const safe = safeRelativePath(relative);
  if (!safe) return undefined;
  const absolute = path.resolve(root, ...safe.split("/"));
  return absolute.startsWith(`${path.resolve(root)}${path.sep}`) ? absolute : undefined;
}

async function verifiedRegularFile(
  root: string,
  relative: string,
  sha256: string,
  bytes?: number,
): Promise<string | undefined> {
  try {
    const absolute = absoluteManifestPath(root, relative);
    if (!absolute) return undefined;
    const stats = fs.lstatSync(absolute);
    if (!stats.isFile() || stats.isSymbolicLink()) return undefined;
    const canonicalRoot = fs.realpathSync.native(root);
    const canonical = fs.realpathSync.native(absolute);
    if (!canonical.startsWith(`${canonicalRoot}${path.sep}`)) return undefined;
    const digest = await hashFile(absolute);
    if (digest.sha256 !== sha256 || (bytes !== undefined && digest.bytes !== bytes)) return undefined;
    return absolute;
  } catch {
    return undefined;
  }
}

export function resolveBundledCorePaths(options: {
  isPackaged: boolean;
  resourcesRoot: string;
  applicationRoot?: string;
}): { catalogPath: string; coreRoot: string } {
  const base = options.isPackaged
    ? path.join(options.resourcesRoot, "toolchains")
    : path.join(options.applicationRoot ?? process.cwd(), "build", "toolchains");
  return {
    catalogPath: path.join(base, "core-catalog.json"),
    coreRoot: path.join(base, "core"),
  };
}

export async function bundledSeedsFromResources(options: {
  coreRoot: string;
  catalog: RuntimeCatalog;
  platform: NodeJS.Platform;
  arch: string;
}): Promise<ExecutableSeed[]> {
  try {
    const targetRoot = path.join(options.coreRoot, `${options.platform}-${options.arch}`);
    const manifestPath = path.join(targetRoot, "manifests", "core-tools.json");
    const stats = fs.lstatSync(manifestPath);
    if (!stats.isFile() || stats.isSymbolicLink() || stats.size > 1024 * 1024) return [];
    const manifest = parseManifest(JSON.parse(fs.readFileSync(manifestPath, "utf8")));
    if (
      !manifest ||
      manifest.catalogRevision !== options.catalog.revision ||
      manifest.platform !== options.platform ||
      manifest.arch !== options.arch
    ) {
      return [];
    }
    const expected = options.catalog.components.filter((component) =>
      component.variants.some((variant) => variant.platform === options.platform && variant.arch === options.arch),
    );
    if (manifest.tools.length !== expected.length) return [];

    for (const license of manifest.licenses) {
      if (!(await verifiedRegularFile(targetRoot, license.path, license.sha256))) return [];
    }
    const seeds: ExecutableSeed[] = [];
    for (const component of expected) {
      const variant = component.variants.find(
        (entry) => entry.platform === options.platform && entry.arch === options.arch,
      );
      const tool = manifest.tools.find((entry) => entry.componentId === component.id);
      if (
        !variant ||
        !tool ||
        tool.version !== component.version ||
        tool.artifactSha256 !== variant.sha256 ||
        !component.provides.includes(tool.capability)
      ) {
        return [];
      }
      const executable = await verifiedRegularFile(targetRoot, tool.executable, tool.sha256, tool.bytes);
      if (!executable) return [];
      seeds.push({
        capability: tool.capability,
        provider: "bundled",
        discovery: `bundled-core:${component.id}:${component.version}`,
        executable,
        argvPrefix: [],
        binDir: path.dirname(executable),
        componentId: component.id,
        componentRoot: targetRoot,
        rank: 2_000,
      });
    }
    return seeds;
  } catch {
    return [];
  }
}

export function legacyUpstreamSearchSeeds(options: {
  homeDir: string;
  platform: NodeJS.Platform;
  fileSystem?: DiscoveryFileSystem;
}): ExecutableSeed[] {
  const fileSystem = options.fileSystem ?? nodeDiscoveryFileSystem;
  const pathApi = options.platform === "win32" ? path.win32 : path.posix;
  const directory = pathApi.join(options.homeDir, ".pi", "agent", "bin");
  const suffix = options.platform === "win32" ? ".exe" : "";
  return [
    ["search.rg", `rg${suffix}`],
    ["search.fd", `fd${suffix}`],
  ].flatMap(([capability, name]) => {
    const executable = pathApi.join(directory, name);
    if (!fileSystem.isFile(executable)) return [];
    return [
      {
        capability: capability as "search.rg" | "search.fd",
        provider: "legacy-upstream-managed" as const,
        discovery: "legacy-upstream-managed:read-only",
        executable,
        argvPrefix: [],
        binDir: directory,
        rank: 9_000,
      },
    ];
  });
}
