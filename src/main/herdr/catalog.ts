import fs from "node:fs";
import path from "node:path";

export interface HerdrRuntimeArtifact {
  upstreamPlatform: string;
  url: string;
  downloadBytes: number;
  sha256: string;
}

export interface HerdrRuntimeCatalog {
  schemaVersion: 1;
  version: "0.8.2";
  protocol: 20;
  apiSchemaVersion: 1;
  apiSchemaSha256: string;
  license: "Apache-2.0";
  artifacts: Record<string, HerdrRuntimeArtifact>;
}

const EXPECTED_ASSETS: Record<string, string> = {
  "darwin-arm64": "herdr-macos-aarch64",
  "darwin-x64": "herdr-macos-x86_64",
  "linux-x64": "herdr-linux-x86_64",
  "win32-x64": "herdr-windows-x86_64.zip",
};

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  return Object.keys(value).sort().join("\0") === [...expected].sort().join("\0");
}

export function parseHerdrRuntimeCatalog(value: unknown): HerdrRuntimeCatalog {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Herdr runtime catalog is invalid");
  const catalog = value as Record<string, unknown>;
  if (
    !exactKeys(catalog, [
      "schemaVersion",
      "version",
      "protocol",
      "apiSchemaVersion",
      "apiSchemaSha256",
      "license",
      "artifacts",
      "fixturesOnly",
    ]) ||
    catalog.schemaVersion !== 1 ||
    catalog.version !== "0.8.2" ||
    catalog.protocol !== 20 ||
    catalog.apiSchemaVersion !== 1 ||
    catalog.license !== "Apache-2.0" ||
    typeof catalog.apiSchemaSha256 !== "string" ||
    !/^(?!0{64}$)[a-f0-9]{64}$/.test(catalog.apiSchemaSha256) ||
    !catalog.artifacts ||
    typeof catalog.artifacts !== "object" ||
    Array.isArray(catalog.artifacts)
  ) {
    throw new Error("Herdr runtime catalog metadata is invalid");
  }
  const artifacts = catalog.artifacts as Record<string, unknown>;
  if (!exactKeys(artifacts, Object.keys(EXPECTED_ASSETS))) throw new Error("Herdr runtime catalog targets are invalid");
  for (const [key, assetName] of Object.entries(EXPECTED_ASSETS)) {
    const raw = artifacts[key];
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error(`Herdr artifact ${key} is invalid`);
    const artifact = raw as Record<string, unknown>;
    const expectedUrl = `https://github.com/herdrdev/herdr/releases/download/v0.8.2/${assetName}`;
    if (
      !exactKeys(artifact, ["upstreamPlatform", "url", "downloadBytes", "sha256"]) ||
      typeof artifact.upstreamPlatform !== "string" ||
      artifact.url !== expectedUrl ||
      !Number.isSafeInteger(artifact.downloadBytes) ||
      Number(artifact.downloadBytes) <= 0 ||
      Number(artifact.downloadBytes) > 128 * 1024 * 1024 ||
      typeof artifact.sha256 !== "string" ||
      !/^(?!0{64}$)[a-f0-9]{64}$/.test(artifact.sha256)
    ) {
      throw new Error(`Herdr artifact ${key} failed validation`);
    }
  }
  return structuredClone(catalog) as unknown as HerdrRuntimeCatalog;
}

export function loadHerdrRuntimeCatalog(catalogPath: string): HerdrRuntimeCatalog {
  if (!path.isAbsolute(catalogPath)) throw new Error("Herdr runtime catalog path must be absolute");
  const raw = fs.readFileSync(catalogPath, "utf8");
  if (Buffer.byteLength(raw) > 64 * 1024) throw new Error("Herdr runtime catalog is too large");
  return parseHerdrRuntimeCatalog(JSON.parse(raw));
}

export function resolveHerdrCatalogPath(options: {
  isPackaged: boolean;
  resourcesRoot: string;
  applicationRoot?: string;
}): string {
  return options.isPackaged
    ? path.join(options.resourcesRoot, "herdr", "runtime-catalog.json")
    : path.join(options.applicationRoot ?? process.cwd(), "build", "herdr", "runtime-catalog.json");
}

export function resolveBundledHerdrRoot(options: {
  isPackaged: boolean;
  resourcesRoot: string;
  platform?: NodeJS.Platform;
  arch?: string;
  applicationRoot?: string;
}): string {
  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
  const base = options.isPackaged
    ? path.join(options.resourcesRoot, "herdr", "bin")
    : path.join(options.applicationRoot ?? process.cwd(), "build", "herdr", "bin");
  return path.join(base, `${platform}-${arch}`);
}

export function findHerdrRuntimeArtifact(
  catalog: HerdrRuntimeCatalog,
  platform: NodeJS.Platform,
  arch: string,
): HerdrRuntimeArtifact {
  const artifact = catalog.artifacts[`${platform}-${arch}`];
  if (!artifact) throw new Error(`Managed Herdr is unavailable for ${platform}-${arch}`);
  return artifact;
}
