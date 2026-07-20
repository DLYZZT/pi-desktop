import fs, { type Dirent } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type {
  RuntimeCatalog,
  RuntimeCatalogComponent,
  RuntimeCatalogVariant,
} from "../../shared/toolchains/catalog-schema.ts";
import { ToolchainError } from "../../shared/toolchains/errors.ts";
import type { ManagedComponentId, PublicToolchainOperation, ToolCandidate } from "../../shared/toolchains/types.ts";
import { MANAGED_COMPONENT_IDS } from "../../shared/toolchains/types.ts";
import { findCatalogComponent, findCatalogVariant } from "./catalog.ts";
import { findComponentEntrypoints } from "./component-entrypoint.ts";
import { downloadRuntimeArtifact, verifyDownloadedArtifact } from "./downloader.ts";
import type { ExecutableSeed, DiscoveryFileSystem } from "./discovery-registry.ts";
import { nodeDiscoveryFileSystem } from "./discovery-registry.ts";
import { extractRuntimeArchive } from "./secure-extractor.ts";
import { runtimeDirectory, type ToolchainPaths } from "./paths.ts";
import { probeExecutableSeed, type CapabilityProbeOptions } from "./probes/capabilities.ts";
import { defaultProbeExecutor, type ProbeExecutor } from "./process-runner.ts";
import { extractPortableGitSfx } from "./portable-git-installer.ts";
import { writeRuntimeManifest } from "./runtime-manifest.ts";
import { ToolchainStateStore, type ToolchainPersistentState } from "./state-store.ts";

export type InstallerProgress = Pick<PublicToolchainOperation, "phase" | "downloadedBytes" | "totalBytes" | "error">;

type DownloadFunction = typeof downloadRuntimeArtifact;
type ExtractFunction = typeof extractRuntimeArchive;
type PortableGitExtractFunction = typeof extractPortableGitSfx;
type ProbeFunction = (seed: ExecutableSeed, options: CapabilityProbeOptions) => Promise<ToolCandidate[]>;

export interface ManagedComponentInstallerOptions {
  paths: ToolchainPaths;
  stateStore: ToolchainStateStore;
  catalog: RuntimeCatalog;
  platform?: NodeJS.Platform;
  arch?: string;
  env?: NodeJS.ProcessEnv;
  tempRoot?: string;
  fileSystem?: DiscoveryFileSystem;
  executor?: ProbeExecutor;
  download?: DownloadFunction;
  fetchImpl?: typeof fetch;
  extract?: ExtractFunction;
  extractPortableGit?: PortableGitExtractFunction;
  probe?: ProbeFunction;
  now?: () => Date;
}

function safeArtifactCacheName(
  component: RuntimeCatalogComponent,
  variant: RuntimeCatalogVariant,
  platform: NodeJS.Platform,
  arch: string,
): string {
  const extension = variant.installer === "portable-git-sfx" ? ".7z.exe" : ".artifact";
  return `${component.id}-${component.version}-${platform}-${arch}${extension}`;
}

function isProcessAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function acquireComponentLock(paths: ToolchainPaths, componentId: ManagedComponentId): () => void {
  fs.mkdirSync(paths.locks, { recursive: true, mode: 0o700 });
  const lockPath = path.join(paths.locks, `${componentId}.lock`);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const descriptor = fs.openSync(lockPath, "wx", 0o600);
      fs.writeFileSync(descriptor, JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }));
      fs.closeSync(descriptor);
      return () => {
        try {
          fs.unlinkSync(lockPath);
        } catch {
          // The operation already released or the app is shutting down.
        }
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      try {
        const value = JSON.parse(fs.readFileSync(lockPath, "utf8")) as { pid?: unknown };
        if (typeof value.pid === "number" && isProcessAlive(value.pid)) break;
        fs.unlinkSync(lockPath);
        continue;
      } catch {
        break;
      }
    }
  }
  throw new ToolchainError({
    code: "TOOLCHAIN_INSTALL_BUSY",
    message: `Another ${componentId} installation is already running`,
  });
}

function maxExtractedBytes(component: RuntimeCatalogComponent, downloadBytes: number, installedBytes?: number): number {
  if (installedBytes) return installedBytes;
  const multiplier = component.id === "cpython" ? 40 : 20;
  return Math.min(4 * 1024 * 1024 * 1024, Math.max(downloadBytes, downloadBytes * multiplier));
}

function keyFilesFromCandidates(runtimeRoot: string, candidates: readonly ToolCandidate[]): string[] {
  const files: string[] = [];
  for (const candidate of candidates) {
    for (const value of [candidate.executable, ...(candidate.argvPrefix ?? [])]) {
      if (!path.isAbsolute(value)) continue;
      const relative = path.relative(runtimeRoot, value);
      if (relative && !relative.startsWith("..") && !path.isAbsolute(relative) && fs.existsSync(value))
        files.push(value);
    }
  }
  return files;
}

function singleBinaryName(componentId: ManagedComponentId, platform: NodeJS.Platform): string {
  const suffix = platform === "win32" ? ".exe" : "";
  if (componentId === "jq" || componentId === "bun" || componentId === "ripgrep" || componentId === "fd") {
    return `${componentId === "ripgrep" ? "rg" : componentId}${suffix}`;
  }
  throw new ToolchainError({
    code: "TOOLCHAIN_UNSUPPORTED",
    message: `${componentId} is not supported by the single-binary installer`,
  });
}

export class ManagedComponentInstaller {
  private readonly paths: ToolchainPaths;
  private readonly stateStore: ToolchainStateStore;
  private readonly catalog: RuntimeCatalog;
  private readonly platform: NodeJS.Platform;
  private readonly arch: string;
  private readonly env: NodeJS.ProcessEnv;
  private readonly tempRoot?: string;
  private readonly fileSystem: DiscoveryFileSystem;
  private readonly executor: ProbeExecutor;
  private readonly download: DownloadFunction;
  private readonly extract: ExtractFunction;
  private readonly extractPortableGit: PortableGitExtractFunction;
  private readonly probe: ProbeFunction;
  private readonly now: () => Date;

  constructor(options: ManagedComponentInstallerOptions) {
    this.paths = options.paths;
    this.stateStore = options.stateStore;
    this.catalog = options.catalog;
    this.platform = options.platform ?? process.platform;
    this.arch = options.arch ?? process.arch;
    this.env = { ...(options.env ?? process.env) };
    this.tempRoot = options.tempRoot;
    this.fileSystem = options.fileSystem ?? nodeDiscoveryFileSystem;
    this.executor = options.executor ?? defaultProbeExecutor;
    this.download =
      options.download ??
      ((componentId, variant, destination, downloadOptions) =>
        downloadRuntimeArtifact(componentId, variant, destination, {
          ...downloadOptions,
          fetchImpl: options.fetchImpl,
        }));
    this.extract = options.extract ?? extractRuntimeArchive;
    this.extractPortableGit = options.extractPortableGit ?? extractPortableGitSfx;
    this.probe = options.probe ?? probeExecutableSeed;
    this.now = options.now ?? (() => new Date());
  }

  async install(
    componentId: ManagedComponentId,
    onProgress: (progress: InstallerProgress) => void = () => {},
    signal?: AbortSignal,
  ): Promise<ToolchainPersistentState> {
    throwIfCancelled(signal, componentId);
    const releaseLock = acquireComponentLock(this.paths, componentId);
    let stagingRoot: string | undefined;
    let partialPath: string | undefined;
    try {
      const component = findCatalogComponent(this.catalog, componentId);
      const variant = findCatalogVariant(component, this.platform, this.arch);
      fs.mkdirSync(this.paths.downloads, { recursive: true, mode: 0o700 });
      const archivePath = path.join(
        this.paths.downloads,
        safeArtifactCacheName(component, variant, this.platform, this.arch),
      );
      partialPath = `${archivePath}.partial`;
      onProgress({ phase: "downloading", downloadedBytes: 0, totalBytes: variant.downloadBytes });
      if (!(await verifyDownloadedArtifact(archivePath, variant))) {
        await this.download(componentId, variant, partialPath, {
          signal,
          onProgress: ({ downloadedBytes, totalBytes }) =>
            onProgress({ phase: "downloading", downloadedBytes, totalBytes }),
        });
        throwIfCancelled(signal, componentId);
        onProgress({ phase: "verifying", downloadedBytes: variant.downloadBytes, totalBytes: variant.downloadBytes });
        if (!(await verifyDownloadedArtifact(partialPath, variant))) {
          throw new ToolchainError({
            code: "TOOLCHAIN_INTEGRITY_FAILED",
            message: "Downloaded artifact failed verification",
          });
        }
        try {
          fs.unlinkSync(archivePath);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
        fs.renameSync(partialPath, archivePath);
      } else {
        onProgress({ phase: "verifying", downloadedBytes: variant.downloadBytes, totalBytes: variant.downloadBytes });
      }

      throwIfCancelled(signal, componentId);
      fs.mkdirSync(this.paths.staging, { recursive: true, mode: 0o700 });
      stagingRoot = fs.mkdtempSync(path.join(this.paths.staging, `${componentId}-`));
      onProgress({ phase: "extracting" });
      if (variant.installer === "safe-archive") {
        await this.extract(archivePath, stagingRoot, variant.archive, {
          maxExtractedBytes: maxExtractedBytes(component, variant.downloadBytes, variant.installedBytes),
        });
      } else if (variant.installer === "single-binary") {
        const executable = path.join(stagingRoot, singleBinaryName(componentId, this.platform));
        fs.copyFileSync(archivePath, executable, fs.constants.COPYFILE_EXCL);
      } else if (variant.installer === "portable-git-sfx") {
        await this.extractPortableGit(archivePath, stagingRoot, {
          platform: this.platform,
          env: this.env,
          executor: this.executor,
        });
      } else {
        throw new ToolchainError({
          code: "TOOLCHAIN_UNSUPPORTED",
          message: `The ${componentId} installer is unsupported`,
        });
      }
      throwIfCancelled(signal, componentId);
      const entrypoints = findComponentEntrypoints(componentId, stagingRoot);
      if (this.platform !== "win32") {
        for (const entrypoint of entrypoints) fs.chmodSync(entrypoint.executable, 0o755);
      }
      const seeds: ExecutableSeed[] = entrypoints.map((entrypoint, index) => ({
        capability: entrypoint.capability,
        provider: "managed",
        discovery: `managed-staging:${componentId}`,
        executable: entrypoint.executable,
        argvPrefix: [],
        binDir: path.dirname(entrypoint.executable),
        componentId,
        componentRoot: stagingRoot,
        rank: 5_000 + index,
      }));
      onProgress({ phase: "probing" });
      const candidates = (
        await Promise.all(
          seeds.map((seed) =>
            this.probe(seed, {
              platform: this.platform,
              arch: this.arch,
              env: this.env,
              tempRoot: this.tempRoot,
              fileSystem: this.fileSystem,
              executor: this.executor,
            }),
          ),
        )
      ).flat();
      throwIfCancelled(signal, componentId);
      const healthy = new Set(
        candidates.filter((candidate) => candidate.health === "healthy").map((candidate) => candidate.capability),
      );
      const missing = component.provides.filter((capability) => !healthy.has(capability));
      if (missing.length > 0) {
        const permissionDenied = candidates.some(
          (candidate) =>
            missing.includes(candidate.capability) && candidate.reasonCode === "TOOLCHAIN_PERMISSION_DENIED",
        );
        throw new ToolchainError({
          code: permissionDenied ? "TOOLCHAIN_PERMISSION_DENIED" : "TOOLCHAIN_BROKEN",
          message: `Managed ${componentId} failed capability probe: ${missing.join(", ")}`,
        });
      }
      const platformArch = `${this.platform}-${this.arch}`;
      await writeRuntimeManifest({
        runtimeRoot: stagingRoot,
        component,
        platformArch,
        catalogRevision: this.catalog.revision,
        artifactSha256: variant.sha256,
        entrypoints,
        keyFiles: keyFilesFromCandidates(stagingRoot, candidates),
        installedAt: this.now().toISOString(),
      });

      throwIfCancelled(signal, componentId);
      onProgress({ phase: "activating" });
      const finalRoot = runtimeDirectory(this.paths, componentId, component.version, this.platform, this.arch);
      fs.mkdirSync(path.dirname(finalRoot), { recursive: true, mode: 0o700 });
      const previousRoot = fs.existsSync(finalRoot) ? `${finalRoot}.previous-${randomUUID()}` : undefined;
      if (previousRoot) fs.renameSync(finalRoot, previousRoot);
      try {
        fs.renameSync(stagingRoot, finalRoot);
        stagingRoot = undefined;
        const state = this.stateStore.update((draft) => {
          const previous = draft.managed[componentId];
          draft.managed[componentId] = {
            activeVersion: component.version,
            platformArch,
            installedVersions: [...new Set([...(previous?.installedVersions ?? []), component.version])],
          };
        });
        if (previousRoot) fs.rmSync(previousRoot, { recursive: true, force: true });
        onProgress({ phase: "ready", downloadedBytes: variant.downloadBytes, totalBytes: variant.downloadBytes });
        return state;
      } catch (error) {
        try {
          if (fs.existsSync(finalRoot)) fs.rmSync(finalRoot, { recursive: true, force: true });
          if (previousRoot && fs.existsSync(previousRoot)) fs.renameSync(previousRoot, finalRoot);
        } catch {
          // Preserve the original error; diagnostics will report any rollback residue.
        }
        throw error;
      }
    } catch (error) {
      const normalized =
        error instanceof ToolchainError
          ? error
          : new ToolchainError({
              code:
                (error as NodeJS.ErrnoException | undefined)?.code === "EACCES" ||
                (error as NodeJS.ErrnoException | undefined)?.code === "EPERM"
                  ? "TOOLCHAIN_PERMISSION_DENIED"
                  : "TOOLCHAIN_INTERNAL",
              message: error instanceof Error ? error.message : `Managed ${componentId} installation failed`,
              cause: error,
            });
      onProgress(
        normalized.code === "TOOLCHAIN_CANCELLED"
          ? { phase: "cancelled" }
          : { phase: "error", error: { code: normalized.code, message: normalized.message } },
      );
      throw normalized;
    } finally {
      if (stagingRoot) {
        try {
          fs.rmSync(stagingRoot, { recursive: true, force: true });
        } catch {
          // Best-effort staging cleanup.
        }
      }
      if (partialPath) {
        try {
          fs.unlinkSync(partialPath);
        } catch {
          // Missing or already-promoted partial artifacts need no cleanup.
        }
      }
      releaseLock();
    }
  }

  /**
   * Converges residue from a process termination before any Host session can
   * use managed files. Future-schema state is deliberately left untouched.
   */
  recoverInterruptedOperations(): void {
    cleanupPartialDownloads(this.paths.downloads);
    cleanupDeadLocks(this.paths.locks);
    const state = this.stateStore.load();
    if (this.stateStore.isCompatibilityReadOnly()) return;
    recoverStagingDirectory(this.paths, state);
    recoverPreviousRuntimeDirectories(this.paths.runtimes);
  }
}

function throwIfCancelled(signal: AbortSignal | undefined, componentId: ManagedComponentId): void {
  if (!signal?.aborted) return;
  throw new ToolchainError({
    code: "TOOLCHAIN_CANCELLED",
    message: `Managed ${componentId} installation was cancelled`,
  });
}

const MAX_RECOVERY_ENTRIES = 512;

function safeDirectoryEntries(directory: string): Dirent[] {
  try {
    return fs.readdirSync(directory, { withFileTypes: true }).slice(0, MAX_RECOVERY_ENTRIES);
  } catch {
    return [];
  }
}

function cleanupPartialDownloads(directory: string): void {
  for (const entry of safeDirectoryEntries(directory)) {
    if (!entry.name.endsWith(".partial")) continue;
    try {
      fs.rmSync(path.join(directory, entry.name), { recursive: true, force: true });
    } catch {
      // A locked partial will be retried or replaced by the next install.
    }
  }
}

function cleanupDeadLocks(directory: string): void {
  for (const entry of safeDirectoryEntries(directory)) {
    if (!entry.isFile() || !entry.name.endsWith(".lock")) continue;
    const lockPath = path.join(directory, entry.name);
    try {
      const value = JSON.parse(fs.readFileSync(lockPath, "utf8")) as { pid?: unknown };
      if (typeof value.pid !== "number" || !isProcessAlive(value.pid)) fs.unlinkSync(lockPath);
    } catch {
      try {
        fs.unlinkSync(lockPath);
      } catch {
        // A concurrently locked entry remains protected by the filesystem.
      }
    }
  }
}

function recoverStagingDirectory(paths: ToolchainPaths, state: ToolchainPersistentState): void {
  const componentPattern = MANAGED_COMPONENT_IDS.join("|");
  const installPattern = new RegExp(`^(?:${componentPattern})-[A-Za-z0-9_-]+$`);
  const prunePattern = new RegExp(`^prune-(?:${componentPattern})-[A-Fa-f0-9-]+$`);
  const removePattern = new RegExp(`^remove-(${componentPattern})-[A-Fa-f0-9-]+$`);
  for (const entry of safeDirectoryEntries(paths.staging)) {
    const staged = path.join(paths.staging, entry.name);
    const remove = entry.name.match(removePattern);
    try {
      if (remove) {
        const componentId = remove[1] as ManagedComponentId;
        const original = path.join(paths.runtimes, componentId);
        if (state.managed[componentId] && !fs.existsSync(original)) fs.renameSync(staged, original);
        else fs.rmSync(staged, { recursive: true, force: true });
      } else if (installPattern.test(entry.name) || prunePattern.test(entry.name)) {
        fs.rmSync(staged, { recursive: true, force: true });
      }
    } catch {
      // Recovery is best-effort; discovery will report any remaining damage.
    }
  }
}

function recoverPreviousRuntimeDirectories(runtimes: string): void {
  for (const component of safeDirectoryEntries(runtimes)) {
    if (!component.isDirectory() || !(MANAGED_COMPONENT_IDS as readonly string[]).includes(component.name)) continue;
    const componentRoot = path.join(runtimes, component.name);
    for (const version of safeDirectoryEntries(componentRoot)) {
      if (!version.isDirectory() || version.isSymbolicLink()) continue;
      const versionRoot = path.join(componentRoot, version.name);
      for (const entry of safeDirectoryEntries(versionRoot)) {
        const match = entry.name.match(/^([a-z0-9_-]+-[a-z0-9_-]+)\.previous-[0-9a-f-]{36}$/i);
        if (!match || !entry.isDirectory() || entry.isSymbolicLink()) continue;
        const previous = path.join(versionRoot, entry.name);
        const active = path.join(versionRoot, match[1]!);
        try {
          if (fs.existsSync(active)) fs.rmSync(previous, { recursive: true, force: true });
          else fs.renameSync(previous, active);
        } catch {
          // Leave the previous runtime intact for a later recovery attempt.
        }
      }
    }
  }
}
