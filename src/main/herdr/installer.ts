import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import semver from "semver";
import type { PublicManagedComponentState } from "../../shared/toolchains/types.ts";
import { ToolchainError } from "../../shared/toolchains/errors.ts";
import type { InstallerProgress } from "../toolchains/installer.ts";
import { darwinCodeDigest } from "../toolchains/darwin-binary-integrity.ts";
import { findHerdrRuntimeArtifact, loadHerdrRuntimeCatalog, type HerdrRuntimeCatalog } from "./catalog.ts";

const HERDR_LICENSE_URL = "https://github.com/herdrdev/herdr/blob/v0.8.2/LICENSE";

export interface BundledHerdrManifest {
  schemaVersion: 1;
  version: string;
  protocol: number;
  apiSchemaVersion: number;
  apiSchemaSha256: string;
  platform: string;
  arch: string;
  executable: string;
  sha256: string;
  bytes: number;
  artifactSha256: string;
  darwinCodeSha256?: string;
  darwinCodeBytes?: number;
}

export interface HerdrInstallerOptions {
  userDataDir: string;
  catalogPath: string;
  bundledRoot: string;
  platform?: NodeJS.Platform;
  arch?: string;
  probe: (
    executable: string,
  ) => Promise<{ version: string; protocol: number; schemaVersion: number; schemaSha256: string }>;
  catalog?: HerdrRuntimeCatalog;
  loadBundle?: () => { manifest: BundledHerdrManifest; executable: string; license: string } | undefined;
}

function isSha256(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

function exactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
): boolean {
  const allowed = new Set([...required, ...optional]);
  return required.every((key) => key in value) && Object.keys(value).every((key) => allowed.has(key));
}

function parseManifest(value: unknown): BundledHerdrManifest | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const manifest = value as Record<string, unknown>;
  if (
    !exactKeys(
      manifest,
      [
        "schemaVersion",
        "version",
        "protocol",
        "apiSchemaVersion",
        "apiSchemaSha256",
        "platform",
        "arch",
        "executable",
        "sha256",
        "bytes",
        "artifactSha256",
      ],
      ["darwinCodeSha256", "darwinCodeBytes"],
    ) ||
    manifest.schemaVersion !== 1 ||
    typeof manifest.version !== "string" ||
    !Number.isSafeInteger(manifest.protocol) ||
    !Number.isSafeInteger(manifest.apiSchemaVersion) ||
    !isSha256(manifest.apiSchemaSha256) ||
    typeof manifest.platform !== "string" ||
    typeof manifest.arch !== "string" ||
    manifest.executable !== "herdr" ||
    !isSha256(manifest.sha256) ||
    !Number.isSafeInteger(manifest.bytes) ||
    Number(manifest.bytes) <= 0 ||
    !isSha256(manifest.artifactSha256) ||
    (manifest.darwinCodeSha256 !== undefined && !isSha256(manifest.darwinCodeSha256)) ||
    (manifest.darwinCodeBytes !== undefined &&
      (!Number.isSafeInteger(manifest.darwinCodeBytes) || Number(manifest.darwinCodeBytes) <= 0)) ||
    (manifest.darwinCodeSha256 === undefined) !== (manifest.darwinCodeBytes === undefined)
  ) {
    return undefined;
  }
  return manifest as unknown as BundledHerdrManifest;
}

function processIsAlive(pid: unknown): boolean {
  if (!Number.isSafeInteger(pid) || Number(pid) <= 0) return false;
  try {
    process.kill(Number(pid), 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function acquireInstallLock(lockPath: string, version: string): () => void {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const descriptor = fs.openSync(lockPath, "wx", 0o600);
      fs.writeFileSync(descriptor, JSON.stringify({ pid: process.pid, version }));
      fs.closeSync(descriptor);
      return () => {
        try {
          fs.unlinkSync(lockPath);
        } catch {
          // The operation already released the lock or the app is shutting down.
        }
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      try {
        const value = JSON.parse(fs.readFileSync(lockPath, "utf8")) as { pid?: unknown };
        if (processIsAlive(value.pid)) break;
        fs.unlinkSync(lockPath);
      } catch (readError) {
        if ((readError as NodeJS.ErrnoException).code === "ENOENT") continue;
        try {
          const info = fs.lstatSync(lockPath);
          // The writer creates and fills this file synchronously. Reclaim only
          // a long-stale malformed regular file owned by this user.
          const owned = typeof process.getuid !== "function" || info.uid === process.getuid();
          if (info.isFile() && !info.isSymbolicLink() && owned && Date.now() - info.mtimeMs > 30_000) {
            fs.unlinkSync(lockPath);
            continue;
          }
        } catch {
          continue;
        }
        break;
      }
    }
  }
  throw new ToolchainError({
    code: "TOOLCHAIN_INSTALL_BUSY",
    message: "Another managed Herdr operation is already running",
  });
}

function assertActive(signal: AbortSignal): void {
  if (signal.aborted) {
    throw new ToolchainError({ code: "TOOLCHAIN_CANCELLED", message: "Managed Herdr operation was cancelled" });
  }
}

function directoryBytes(root: string, maxEntries = 10_000): number | undefined {
  if (!fs.existsSync(root)) return 0;
  const pending = [root];
  let visited = 0;
  let bytes = 0;
  try {
    while (pending.length > 0) {
      const current = pending.pop()!;
      const stats = fs.lstatSync(current);
      visited += 1;
      if (visited > maxEntries) return undefined;
      if (stats.isSymbolicLink()) continue;
      if (stats.isFile()) bytes += stats.size;
      else if (stats.isDirectory()) {
        for (const entry of fs.readdirSync(current)) pending.push(path.join(current, entry));
      }
    }
    return bytes;
  } catch {
    return undefined;
  }
}

function executableIntegrity(
  executable: string,
  root: string,
  manifest: BundledHerdrManifest,
  platform: NodeJS.Platform,
): boolean {
  try {
    const stats = fs.lstatSync(executable);
    if (!stats.isFile() || stats.isSymbolicLink()) return false;
    const canonicalRoot = fs.realpathSync.native(root);
    const canonical = fs.realpathSync.native(executable);
    if (canonical !== canonicalRoot && !canonical.startsWith(`${canonicalRoot}${path.sep}`)) return false;
    const contents = fs.readFileSync(executable);
    if (platform === "darwin") {
      if (!manifest.darwinCodeSha256 || !manifest.darwinCodeBytes) return false;
      const digest = darwinCodeDigest(contents, manifest.darwinCodeBytes);
      return digest?.sha256 === manifest.darwinCodeSha256 && digest.bytes === manifest.darwinCodeBytes;
    }
    return (
      contents.length === manifest.bytes && createHash("sha256").update(contents).digest("hex") === manifest.sha256
    );
  } catch {
    return false;
  }
}

function installedVersions(runtimesRoot: string, platform: NodeJS.Platform, arch: string): string[] {
  try {
    return fs
      .readdirSync(runtimesRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && semver.valid(entry.name))
      .filter((entry) =>
        fs.existsSync(
          path.join(runtimesRoot, entry.name, `${platform}-${arch}`, platform === "win32" ? "herdr.exe" : "herdr"),
        ),
      )
      .map((entry) => entry.name)
      .sort(semver.rcompare);
  } catch {
    return [];
  }
}

export class HerdrInstaller {
  private readonly platform: NodeJS.Platform;
  private readonly arch: string;
  private readonly catalog: HerdrRuntimeCatalog;

  constructor(private readonly options: HerdrInstallerOptions) {
    this.platform = options.platform ?? process.platform;
    this.arch = options.arch ?? process.arch;
    this.catalog = options.catalog ?? loadHerdrRuntimeCatalog(options.catalogPath);
  }

  inspect(): PublicManagedComponentState {
    const target = `${this.platform}-${this.arch}`;
    const artifact = this.catalog.artifacts[target];
    const runtimesRoot = path.join(this.options.userDataDir, "herdr", "runtimes");
    if (this.platform === "win32" || !artifact) {
      return {
        componentId: "herdr",
        installed: false,
        availableVersion: this.catalog.version,
        platformArch: target,
        downloadBytes: 0,
        sourceName: "Bundled with Pi Desktop",
        licenseName: this.catalog.license,
        licenseUrl: HERDR_LICENSE_URL,
        health: "unsupported",
        canInstall: false,
        canRepair: false,
        canRemove: false,
      };
    }

    const bundle = this.loadVerifiedBundle();
    const versions = installedVersions(runtimesRoot, this.platform, this.arch);
    const activeVersion = versions[0];
    const installed = Boolean(activeVersion);
    const currentExecutable = this.managedExecutable(this.catalog.version);
    const currentInstalled = fs.existsSync(currentExecutable);
    const currentHealthy = Boolean(
      currentInstalled &&
      bundle &&
      executableIntegrity(currentExecutable, runtimesRoot, bundle.manifest, this.platform),
    );
    return {
      componentId: "herdr",
      installed,
      ...(activeVersion ? { activeVersion } : {}),
      availableVersion: this.catalog.version,
      platformArch: target,
      downloadBytes: 0,
      installedBytes: artifact.downloadBytes,
      diskBytes: directoryBytes(runtimesRoot),
      sourceName: "Bundled with Pi Desktop",
      licenseName: this.catalog.license,
      licenseUrl: HERDR_LICENSE_URL,
      health: currentInstalled ? (currentHealthy ? "healthy" : "modified") : installed ? "unverified" : "missing",
      canInstall: Boolean(bundle && !currentInstalled),
      canRepair: Boolean(bundle && currentInstalled),
      canRemove: installed,
    };
  }

  async install(
    onProgress: (progress: InstallerProgress) => void = () => undefined,
    signal: AbortSignal = new AbortController().signal,
  ): Promise<string> {
    if (this.platform === "win32") {
      throw new ToolchainError({
        code: "TOOLCHAIN_UNSUPPORTED",
        message: "Managed Herdr is not supported on Windows in this release",
      });
    }
    const artifact = findHerdrRuntimeArtifact(this.catalog, this.platform, this.arch);
    const herdrRoot = path.join(this.options.userDataDir, "herdr");
    const locksRoot = path.join(herdrRoot, "locks");
    const stagingRoot = path.join(herdrRoot, "staging");
    fs.mkdirSync(locksRoot, { recursive: true, mode: 0o700 });
    fs.mkdirSync(stagingRoot, { recursive: true, mode: 0o700 });
    const releaseLock = acquireInstallLock(path.join(locksRoot, "install.lock"), this.catalog.version);
    const staging = fs.mkdtempSync(path.join(stagingRoot, "install-"));
    let previousRoot: string | undefined;
    try {
      assertActive(signal);
      onProgress({ phase: "verifying", downloadedBytes: 0, totalBytes: artifact.downloadBytes });
      const bundle = this.loadVerifiedBundle();
      if (!bundle || bundle.manifest.artifactSha256 !== artifact.sha256) {
        throw new ToolchainError({
          code: "TOOLCHAIN_INTEGRITY_FAILED",
          message: "The bundled Herdr runtime failed integrity verification",
        });
      }
      const stagedExecutable = path.join(staging, "herdr");
      fs.copyFileSync(bundle.executable, stagedExecutable, fs.constants.COPYFILE_EXCL);
      onProgress({
        phase: "verifying",
        downloadedBytes: artifact.downloadBytes,
        totalBytes: artifact.downloadBytes,
      });
      fs.chmodSync(stagedExecutable, 0o755);
      fs.copyFileSync(bundle.license, path.join(staging, "LICENSE"), fs.constants.COPYFILE_EXCL);
      if (!executableIntegrity(stagedExecutable, staging, bundle.manifest, this.platform)) {
        throw new ToolchainError({
          code: "TOOLCHAIN_INTEGRITY_FAILED",
          message: "The staged Herdr runtime failed integrity verification",
        });
      }

      assertActive(signal);
      onProgress({ phase: "probing" });
      await this.assertCompatible(stagedExecutable);
      assertActive(signal);
      onProgress({ phase: "activating" });
      const finalRoot = path.dirname(this.managedExecutable(this.catalog.version));
      fs.mkdirSync(path.dirname(finalRoot), { recursive: true, mode: 0o700 });
      if (fs.existsSync(finalRoot)) {
        previousRoot = `${finalRoot}.previous-${randomUUID()}`;
        fs.renameSync(finalRoot, previousRoot);
      }
      try {
        fs.renameSync(staging, finalRoot);
      } catch (error) {
        if (previousRoot && fs.existsSync(previousRoot)) fs.renameSync(previousRoot, finalRoot);
        throw error;
      }
      const installed = path.join(finalRoot, "herdr");
      try {
        if (!executableIntegrity(installed, finalRoot, bundle.manifest, this.platform)) {
          throw new ToolchainError({
            code: "TOOLCHAIN_INTEGRITY_FAILED",
            message: "The activated Herdr runtime failed integrity verification",
          });
        }
        await this.assertCompatible(installed);
      } catch (error) {
        fs.rmSync(finalRoot, { recursive: true, force: true });
        if (previousRoot && fs.existsSync(previousRoot)) fs.renameSync(previousRoot, finalRoot);
        throw error;
      }
      if (previousRoot) fs.rmSync(previousRoot, { recursive: true, force: true });
      onProgress({ phase: "ready" });
      return installed;
    } catch (error) {
      if (error instanceof ToolchainError) throw error;
      const code = (error as NodeJS.ErrnoException).code;
      throw new ToolchainError({
        code:
          code === "ENOSPC" || code === "EDQUOT"
            ? "TOOLCHAIN_DISK_FULL"
            : code === "EACCES" || code === "EPERM" || code === "EROFS"
              ? "TOOLCHAIN_PERMISSION_DENIED"
              : "TOOLCHAIN_INTERNAL",
        message: "The bundled Herdr runtime could not be activated",
        cause: error,
      });
    } finally {
      releaseLock();
      fs.rmSync(staging, { recursive: true, force: true });
    }
  }

  async remove(): Promise<void> {
    const herdrRoot = path.join(this.options.userDataDir, "herdr");
    const runtimesRoot = path.join(herdrRoot, "runtimes");
    if (!fs.existsSync(runtimesRoot)) return;
    const locksRoot = path.join(herdrRoot, "locks");
    const stagingRoot = path.join(herdrRoot, "staging");
    fs.mkdirSync(locksRoot, { recursive: true, mode: 0o700 });
    fs.mkdirSync(stagingRoot, { recursive: true, mode: 0o700 });
    const releaseLock = acquireInstallLock(path.join(locksRoot, "install.lock"), this.catalog.version);
    const trash = path.join(stagingRoot, `remove-${randomUUID()}`);
    try {
      fs.renameSync(runtimesRoot, trash);
      fs.rmSync(trash, { recursive: true, force: true });
    } catch (error) {
      if (!fs.existsSync(runtimesRoot) && fs.existsSync(trash)) fs.renameSync(trash, runtimesRoot);
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw new ToolchainError({
        code: "TOOLCHAIN_PERMISSION_DENIED",
        message: "Managed Herdr could not be removed",
        cause: error,
      });
    } finally {
      releaseLock();
    }
  }

  private managedExecutable(version: string): string {
    return path.join(this.options.userDataDir, "herdr", "runtimes", version, `${this.platform}-${this.arch}`, "herdr");
  }

  private loadVerifiedBundle(): { manifest: BundledHerdrManifest; executable: string; license: string } | undefined {
    if (this.options.loadBundle) return this.options.loadBundle();
    try {
      const manifestPath = path.join(this.options.bundledRoot, "manifest.json");
      const manifestInfo = fs.lstatSync(manifestPath);
      if (!manifestInfo.isFile() || manifestInfo.isSymbolicLink() || manifestInfo.size > 64 * 1024) return undefined;
      const manifest = parseManifest(JSON.parse(fs.readFileSync(manifestPath, "utf8")));
      if (
        !manifest ||
        manifest.version !== this.catalog.version ||
        manifest.protocol !== this.catalog.protocol ||
        manifest.apiSchemaVersion !== this.catalog.apiSchemaVersion ||
        manifest.apiSchemaSha256 !== this.catalog.apiSchemaSha256 ||
        manifest.platform !== this.platform ||
        manifest.arch !== this.arch
      ) {
        return undefined;
      }
      const artifact = findHerdrRuntimeArtifact(this.catalog, this.platform, this.arch);
      if (
        manifest.artifactSha256 !== artifact.sha256 ||
        manifest.sha256 !== artifact.sha256 ||
        manifest.bytes !== artifact.downloadBytes
      ) {
        return undefined;
      }
      const executable = path.join(this.options.bundledRoot, manifest.executable);
      const license = path.join(this.options.bundledRoot, "LICENSE");
      const licenseInfo = fs.lstatSync(license);
      if (!licenseInfo.isFile() || licenseInfo.isSymbolicLink()) return undefined;
      if (!executableIntegrity(executable, this.options.bundledRoot, manifest, this.platform)) return undefined;
      return { manifest, executable, license };
    } catch {
      return undefined;
    }
  }

  private async assertCompatible(executable: string): Promise<void> {
    const probe = await this.options.probe(executable);
    if (
      probe.version !== this.catalog.version ||
      probe.protocol !== this.catalog.protocol ||
      probe.schemaVersion !== this.catalog.apiSchemaVersion ||
      probe.schemaSha256 !== this.catalog.apiSchemaSha256
    ) {
      throw new ToolchainError({
        code: "TOOLCHAIN_BROKEN",
        message: "The bundled Herdr runtime failed the pinned compatibility probe",
      });
    }
  }
}

export const __test = { parseManifest, executableIntegrity, acquireInstallLock };
