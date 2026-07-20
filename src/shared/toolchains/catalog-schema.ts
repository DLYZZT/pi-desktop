import { MANAGED_COMPONENT_IDS, TOOL_CAPABILITY_IDS, type ManagedComponentId, type ToolCapabilityId } from "./types.ts";

export const TOOLCHAIN_CATALOG_SCHEMA_VERSION = 2 as const;

export const TOOLCHAIN_PLATFORMS = ["darwin", "win32", "linux"] as const;
export type ToolchainPlatform = (typeof TOOLCHAIN_PLATFORMS)[number];

export const TOOLCHAIN_ARCHES = ["x64", "arm64"] as const;
export type ToolchainArch = (typeof TOOLCHAIN_ARCHES)[number];

// Keep the schema equal to formats handled by the app-owned extractor. Adding a
// format requires extractor tests before a production catalog can reference it.
export const TOOLCHAIN_ARCHIVE_FORMATS = ["zip", "tar.gz", "7z-sfx", "binary"] as const;
export type ToolchainArchiveFormat = (typeof TOOLCHAIN_ARCHIVE_FORMATS)[number];

export const TOOLCHAIN_INSTALLERS = ["safe-archive", "single-binary", "portable-git-sfx"] as const;
export type ToolchainInstallerId = (typeof TOOLCHAIN_INSTALLERS)[number];

export interface RuntimeCatalogVariant {
  platform: ToolchainPlatform;
  arch: ToolchainArch;
  url: string;
  sha256: string;
  downloadBytes: number;
  installedBytes?: number;
  archive: ToolchainArchiveFormat;
  installer: ToolchainInstallerId;
}

export interface RuntimeCatalogComponent {
  id: ManagedComponentId;
  version: string;
  provides: ToolCapabilityId[];
  license: {
    name: string;
    url: string;
  };
  variants: RuntimeCatalogVariant[];
}

export interface RuntimeCatalog {
  schemaVersion: typeof TOOLCHAIN_CATALOG_SCHEMA_VERSION;
  revision: number;
  components: RuntimeCatalogComponent[];
}

const COMPONENT_URL_PREFIXES: Record<ManagedComponentId, readonly string[]> = {
  "portable-git": ["https://github.com/git-for-windows/git/releases/download/"],
  "node-lts": ["https://nodejs.org/dist/"],
  cpython: ["https://github.com/astral-sh/python-build-standalone/releases/download/"],
  uv: ["https://github.com/astral-sh/uv/releases/download/", "https://releases.astral.sh/github/uv/"],
  ripgrep: ["https://github.com/BurntSushi/ripgrep/releases/download/"],
  fd: ["https://github.com/sharkdp/fd/releases/download/"],
  jq: ["https://github.com/jqlang/jq/releases/download/"],
  bun: ["https://github.com/oven-sh/bun/releases/download/"],
};

export function isCatalogArtifactUrlAllowed(componentId: ManagedComponentId, url: string): boolean {
  return COMPONENT_URL_PREFIXES[componentId].some((prefix) => url.startsWith(prefix));
}

const MAX_ARTIFACT_BYTES = 2 * 1024 * 1024 * 1024;
const PLACEHOLDER_PATTERN = /(?:<[^>]+>|\blatest\b|\bplaceholder\b|\btodo\b)/i;

function assertRecord(value: unknown, path: string): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Invalid toolchain catalog: ${path} must be an object`);
  }
}

function assertExactKeys(value: Record<string, unknown>, allowed: readonly string[], path: string): void {
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unknown.length > 0) {
    throw new Error(`Invalid toolchain catalog: ${path} contains unknown keys: ${unknown.join(", ")}`);
  }
}

function requireString(value: unknown, path: string): string {
  if (typeof value !== "string" || value.trim() !== value || value.length === 0) {
    throw new Error(`Invalid toolchain catalog: ${path} must be a non-empty trimmed string`);
  }
  return value;
}

function requirePositiveInteger(value: unknown, path: string, max = Number.MAX_SAFE_INTEGER): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0 || (value as number) > max) {
    throw new Error(`Invalid toolchain catalog: ${path} must be a positive integer no greater than ${max}`);
  }
  return value as number;
}

function requireEnum<T extends string>(value: unknown, values: readonly T[], path: string): T {
  if (typeof value !== "string" || !values.includes(value as T)) {
    throw new Error(`Invalid toolchain catalog: ${path} must be one of ${values.join(", ")}`);
  }
  return value as T;
}

function parseVariant(value: unknown, componentId: ManagedComponentId, index: number): RuntimeCatalogVariant {
  const path = `components.${componentId}.variants[${index}]`;
  assertRecord(value, path);
  assertExactKeys(
    value,
    ["platform", "arch", "url", "sha256", "downloadBytes", "installedBytes", "archive", "installer"],
    path,
  );

  const platform = requireEnum(value.platform, TOOLCHAIN_PLATFORMS, `${path}.platform`);
  const arch = requireEnum(value.arch, TOOLCHAIN_ARCHES, `${path}.arch`);
  const url = requireString(value.url, `${path}.url`);
  if (PLACEHOLDER_PATTERN.test(url)) {
    throw new Error(`Invalid toolchain catalog: ${path}.url contains a placeholder or latest alias`);
  }
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(url);
  } catch {
    throw new Error(`Invalid toolchain catalog: ${path}.url is not a URL`);
  }
  if (parsedUrl.protocol !== "https:" || parsedUrl.username || parsedUrl.password || parsedUrl.hash) {
    throw new Error(`Invalid toolchain catalog: ${path}.url must be credential-free HTTPS without a fragment`);
  }
  if (!isCatalogArtifactUrlAllowed(componentId, url)) {
    throw new Error(`Invalid toolchain catalog: ${path}.url is outside the ${componentId} allowlist`);
  }

  const sha256 = requireString(value.sha256, `${path}.sha256`).toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(sha256)) {
    throw new Error(`Invalid toolchain catalog: ${path}.sha256 must contain exactly 64 hexadecimal characters`);
  }
  const downloadBytes = requirePositiveInteger(value.downloadBytes, `${path}.downloadBytes`, MAX_ARTIFACT_BYTES);
  const installedBytes =
    value.installedBytes === undefined
      ? undefined
      : requirePositiveInteger(value.installedBytes, `${path}.installedBytes`, MAX_ARTIFACT_BYTES * 4);
  const archive = requireEnum(value.archive, TOOLCHAIN_ARCHIVE_FORMATS, `${path}.archive`);
  const installer = requireEnum(value.installer, TOOLCHAIN_INSTALLERS, `${path}.installer`);

  if (installer === "safe-archive" && !["zip", "tar.gz"].includes(archive)) {
    throw new Error(`Invalid toolchain catalog: ${path} safe-archive cannot install ${archive}`);
  }
  if (installer === "single-binary" && archive !== "binary") {
    throw new Error(`Invalid toolchain catalog: ${path} single-binary requires archive=binary`);
  }
  if (
    installer === "portable-git-sfx" &&
    (componentId !== "portable-git" || platform !== "win32" || archive !== "7z-sfx")
  ) {
    throw new Error(
      `Invalid toolchain catalog: ${path} portable-git-sfx is restricted to portable-git win32 7z-sfx assets`,
    );
  }

  return {
    platform,
    arch,
    url,
    sha256,
    downloadBytes,
    installedBytes,
    archive,
    installer,
  };
}

function parseComponent(value: unknown, index: number): RuntimeCatalogComponent {
  const path = `components[${index}]`;
  assertRecord(value, path);
  assertExactKeys(value, ["id", "version", "provides", "license", "variants"], path);

  const id = requireEnum(value.id, MANAGED_COMPONENT_IDS, `${path}.id`);
  const version = requireString(value.version, `${path}.version`);
  if (PLACEHOLDER_PATTERN.test(version)) {
    throw new Error(`Invalid toolchain catalog: ${path}.version contains a placeholder or latest alias`);
  }
  if (!/^[0-9A-Za-z][0-9A-Za-z.+_-]{0,127}$/.test(version) || version.includes("..")) {
    throw new Error(`Invalid toolchain catalog: ${path}.version is not a safe path segment`);
  }

  if (!Array.isArray(value.provides) || value.provides.length === 0) {
    throw new Error(`Invalid toolchain catalog: ${path}.provides must be a non-empty array`);
  }
  const provides = value.provides.map((entry, capabilityIndex) =>
    requireEnum(entry, TOOL_CAPABILITY_IDS, `${path}.provides[${capabilityIndex}]`),
  );
  if (new Set(provides).size !== provides.length) {
    throw new Error(`Invalid toolchain catalog: ${path}.provides contains duplicates`);
  }

  assertRecord(value.license, `${path}.license`);
  assertExactKeys(value.license, ["name", "url"], `${path}.license`);
  const licenseName = requireString(value.license.name, `${path}.license.name`);
  const licenseUrl = requireString(value.license.url, `${path}.license.url`);
  let parsedLicenseUrl: URL;
  try {
    parsedLicenseUrl = new URL(licenseUrl);
  } catch {
    throw new Error(`Invalid toolchain catalog: ${path}.license.url is not a URL`);
  }
  if (parsedLicenseUrl.protocol !== "https:") {
    throw new Error(`Invalid toolchain catalog: ${path}.license.url must use HTTPS`);
  }

  if (!Array.isArray(value.variants) || value.variants.length === 0) {
    throw new Error(`Invalid toolchain catalog: ${path}.variants must be a non-empty array`);
  }
  const variants = value.variants.map((variant, variantIndex) => parseVariant(variant, id, variantIndex));
  const variantKeys = variants.map((variant) => `${variant.platform}-${variant.arch}`);
  if (new Set(variantKeys).size !== variantKeys.length) {
    throw new Error(`Invalid toolchain catalog: ${path}.variants contains duplicate platform/arch pairs`);
  }

  return {
    id,
    version,
    provides,
    license: { name: licenseName, url: licenseUrl },
    variants,
  };
}

export function parseRuntimeCatalog(value: unknown): RuntimeCatalog {
  assertRecord(value, "root");
  assertExactKeys(value, ["schemaVersion", "revision", "components"], "root");
  if (value.schemaVersion !== TOOLCHAIN_CATALOG_SCHEMA_VERSION) {
    throw new Error(`Invalid toolchain catalog: schemaVersion must be ${TOOLCHAIN_CATALOG_SCHEMA_VERSION}`);
  }
  const revision = requirePositiveInteger(value.revision, "revision");
  if (!Array.isArray(value.components) || value.components.length === 0) {
    throw new Error("Invalid toolchain catalog: components must be a non-empty array");
  }
  const components = value.components.map(parseComponent);
  const componentVersions = components.map((component) => `${component.id}\0${component.version}`);
  if (new Set(componentVersions).size !== componentVersions.length) {
    throw new Error("Invalid toolchain catalog: component ID/version pairs must be unique");
  }
  return {
    schemaVersion: TOOLCHAIN_CATALOG_SCHEMA_VERSION,
    revision,
    components,
  };
}
