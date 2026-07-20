import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type {
  CommandDescriptor,
  ExecutionIntent,
  ManagedComponentId,
  ProjectToolRequirements,
  PublicManagedComponentState,
  PublicToolchainCacheState,
  PublicToolchainOperation,
  PublicToolchainState,
  ToolchainActionRequest,
  ToolCandidate,
  ToolCapabilityId,
  ToolchainErrorCode,
  ToolchainSnapshot,
  ToolchainResolution,
  ToolPreference,
} from "../../shared/toolchains/types";
import { TOOL_CAPABILITY_IDS } from "../../shared/toolchains/types.ts";
import type { RuntimeCatalog } from "../../shared/toolchains/catalog-schema.ts";
import { ToolchainError } from "../../shared/toolchains/errors.ts";
import {
  isToolPathInside,
  normalizeToolPath,
  normalizeAndDedupeCandidates,
  redactToolPath,
  toolPathComparisonKey,
  type PathRedactionRoot,
} from "./candidate-normalizer.ts";
import {
  DiscoveryRegistry,
  nodeDiscoveryFileSystem,
  type DiscoveryFileSystem,
  type ExecutableSeed,
} from "./discovery-registry.ts";
import { probeExecutableSeed, type CapabilityProbeOptions } from "./probes/capabilities.ts";
import { buildPublicToolchainState, commandDescriptorFromCandidate, selectDefaultCandidates } from "./public-state.ts";
import { defaultProbeExecutor, type ProbeExecutor } from "./process-runner.ts";
import { loadRuntimeCatalog } from "./catalog.ts";
import { ManagedComponentInstaller, type InstallerProgress } from "./installer.ts";
import { createToolchainPaths, runtimeDirectory, type ToolchainPaths } from "./paths.ts";
import { managedSeedsFromState } from "./runtime-manifest.ts";
import { ToolchainStateStore, emptyToolchainState, type ToolchainPersistentState } from "./state-store.ts";
import {
  detectProjectTools,
  nodeVersionSatisfies,
  pythonVersionSatisfies,
  type DetectedProjectTools,
} from "./project-detector.ts";
import { ensurePythonShims } from "./shims.ts";
import { bundledSeedsFromResources, legacyUpstreamSearchSeeds } from "./bundled-core.ts";
import { portableGitNativePathEntries, portableGitShellEnvPatch, portableGitShellPathEntries } from "./environment.ts";

const DEFAULT_PROBE_CONCURRENCY = 6;
const PROFILE_COMPONENTS: Readonly<Record<string, readonly ManagedComponentId[]>> = {
  "javascript-essentials": ["node-lts"],
  "python-essentials": ["uv", "cpython"],
  "windows-shell-essentials": ["portable-git"],
  "cli-essentials": ["jq"],
};

const COMPONENT_SOURCE_NAMES: Readonly<Record<ManagedComponentId, string>> = {
  "portable-git": "Git for Windows",
  "node-lts": "Node.js",
  cpython: "Astral python-build-standalone / CPython",
  uv: "Astral uv",
  ripgrep: "BurntSushi/ripgrep",
  fd: "sharkdp/fd",
  jq: "jqlang/jq",
  bun: "Oven Bun",
};

/**
 * Measures a private toolchain directory without following symlinks. Returning
 * undefined is intentional: an unreadable or unexpectedly large tree should
 * be shown as unknown rather than as a misleading partial total.
 */
export function boundedDirectoryBytes(root: string, maxEntries = 100_000): number | undefined {
  if (!path.isAbsolute(root) || maxEntries < 1) return undefined;
  const pending = [root];
  let entries = 0;
  let bytes = 0;
  try {
    while (pending.length > 0) {
      const current = pending.pop()!;
      const stat = fs.lstatSync(current);
      entries += 1;
      if (entries > maxEntries) return undefined;
      if (stat.isSymbolicLink()) continue;
      if (stat.isFile()) {
        bytes += stat.size;
        continue;
      }
      if (!stat.isDirectory()) continue;
      for (const name of fs.readdirSync(current)) pending.push(path.join(current, name));
    }
    return bytes;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? 0 : undefined;
  }
}

export interface ToolchainManagerOptions {
  platform?: NodeJS.Platform;
  arch?: string;
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
  tempRoot?: string;
  userDataRoot?: string;
  resourcesRoot?: string;
  fileSystem?: DiscoveryFileSystem;
  executor?: ProbeExecutor;
  registry?: Pick<DiscoveryRegistry, "collect">;
  probe?: (seed: ExecutableSeed, options: CapabilityProbeOptions) => Promise<ToolCandidate[]>;
  probeConcurrency?: number;
  now?: () => Date;
  catalog?: RuntimeCatalog;
  catalogPath?: string;
  coreCatalog?: RuntimeCatalog;
  coreCatalogPath?: string;
  bundledCoreRoot?: string;
  legacySearchSeeds?: ExecutableSeed[];
  paths?: ToolchainPaths;
  stateStore?: ToolchainStateStore;
  installer?: ManagedComponentInstaller;
  fetchImpl?: typeof fetch;
  legacyNpmCommand?: readonly string[];
  isRuntimeInUse?: () => boolean;
}

export interface ResolveProjectOptions {
  trusted?: boolean;
  intent?: ExecutionIntent;
}

async function mapConcurrent<T, R>(
  values: readonly T[],
  concurrency: number,
  mapper: (value: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(values.length);
  let nextIndex = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= values.length) return;
      results[index] = await mapper(values[index]!, index);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(Math.max(1, concurrency), Math.max(1, values.length)) }, () => worker()),
  );
  return results;
}

export class ToolchainManager {
  private readonly platform: NodeJS.Platform;
  private readonly arch: string;
  private readonly env: NodeJS.ProcessEnv;
  private readonly tempRoot?: string;
  private readonly fileSystem: DiscoveryFileSystem;
  private readonly registry: Pick<DiscoveryRegistry, "collect">;
  private readonly executor: ProbeExecutor;
  private readonly probe: (seed: ExecutableSeed, options: CapabilityProbeOptions) => Promise<ToolCandidate[]>;
  private readonly probeConcurrency: number;
  private readonly now: () => Date;
  private readonly redactionRoots: PathRedactionRoot[];
  private preferences: Partial<Record<ToolCapabilityId, ToolPreference>> = {};
  private readonly listeners = new Set<(snapshot: ToolchainSnapshot) => void>();
  private scanPromise: Promise<ToolchainSnapshot> | null = null;
  private readonly resolutionCache = new Map<string, ToolchainResolution>();
  private readonly paths?: ToolchainPaths;
  private readonly catalog?: RuntimeCatalog;
  private readonly coreCatalog?: RuntimeCatalog;
  private readonly catalogLoadError?: PublicToolchainState["lastErrorCode"];
  private readonly bundledCoreRoot?: string;
  private readonly legacySearchSeeds: ExecutableSeed[];
  private readonly stateStore?: ToolchainStateStore;
  private readonly installer?: ManagedComponentInstaller;
  private readonly isRuntimeInUse: () => boolean;
  private persistentState: ToolchainPersistentState;
  private readonly operations = new Map<string, PublicToolchainOperation>();
  private readonly installs = new Map<ManagedComponentId, Promise<PublicToolchainState>>();
  private readonly installControllers = new Map<ManagedComponentId, AbortController>();
  private snapshot: ToolchainSnapshot;

  constructor(options: ToolchainManagerOptions = {}) {
    this.platform = options.platform ?? process.platform;
    this.arch = options.arch ?? process.arch;
    this.env = { ...(options.env ?? process.env) };
    this.tempRoot = options.tempRoot;
    this.fileSystem = options.fileSystem ?? nodeDiscoveryFileSystem;
    this.executor = options.executor ?? defaultProbeExecutor;
    this.registry =
      options.registry ??
      new DiscoveryRegistry({
        platform: this.platform,
        arch: this.arch,
        env: this.env,
        homeDir: options.homeDir,
        fileSystem: this.fileSystem,
        executor: this.executor,
        legacyNpmCommand: options.legacyNpmCommand,
      });
    this.probe = options.probe ?? probeExecutableSeed;
    this.probeConcurrency = Math.max(1, options.probeConcurrency ?? DEFAULT_PROBE_CONCURRENCY);
    this.now = options.now ?? (() => new Date());
    this.paths = options.paths ?? (options.userDataRoot ? createToolchainPaths(options.userDataRoot) : undefined);
    let catalogLoadFailed = false;
    if (options.catalog) this.catalog = options.catalog;
    else if (options.catalogPath) {
      try {
        this.catalog = loadRuntimeCatalog(options.catalogPath);
      } catch {
        catalogLoadFailed = true;
      }
    }
    if (options.coreCatalog) this.coreCatalog = options.coreCatalog;
    else if (options.coreCatalogPath) {
      try {
        this.coreCatalog = loadRuntimeCatalog(options.coreCatalogPath);
      } catch {
        catalogLoadFailed = true;
      }
    }
    this.catalogLoadError = catalogLoadFailed ? "TOOLCHAIN_INVALID_CATALOG" : undefined;
    this.bundledCoreRoot = options.bundledCoreRoot;
    this.legacySearchSeeds =
      options.legacySearchSeeds ??
      (options.homeDir && !options.registry
        ? legacyUpstreamSearchSeeds({
            homeDir: options.homeDir,
            platform: this.platform,
            fileSystem: this.fileSystem,
          })
        : []);
    this.stateStore = options.stateStore ?? (this.paths ? new ToolchainStateStore(this.paths) : undefined);
    this.persistentState = this.stateStore?.load() ?? emptyToolchainState();
    this.preferences = Object.fromEntries(
      Object.entries(this.persistentState.preferences).map(([capability, value]) => [
        capability,
        value?.mode ?? "auto",
      ]),
    );
    this.installer =
      options.installer ??
      (this.paths && this.catalog && this.stateStore
        ? new ManagedComponentInstaller({
            paths: this.paths,
            catalog: this.catalog,
            stateStore: this.stateStore,
            platform: this.platform,
            arch: this.arch,
            env: this.env,
            tempRoot: this.tempRoot,
            fileSystem: this.fileSystem,
            executor: this.executor,
            probe: this.probe,
            now: this.now,
            fetchImpl: options.fetchImpl,
          })
        : undefined);
    this.isRuntimeInUse = options.isRuntimeInUse ?? (() => false);
    this.redactionRoots = [
      ...(options.userDataRoot ? [{ path: options.userDataRoot, label: "$APP_DATA" }] : []),
      ...(options.resourcesRoot ? [{ path: options.resourcesRoot, label: "$APP_RESOURCES" }] : []),
      ...(options.homeDir ? [{ path: options.homeDir, label: "~" }] : []),
    ];
    this.snapshot = this.createSnapshot([], false, undefined);
  }

  initialize(): Promise<ToolchainSnapshot> {
    this.installer?.recoverInterruptedOperations();
    this.pruneManagedVersionsAtStartup();
    return this.rescan();
  }

  getSnapshot(): ToolchainSnapshot {
    return this.snapshot;
  }

  getPublicState(): PublicToolchainState {
    return this.snapshot.publicState;
  }

  async getPublicStateForProject(cwd: string): Promise<PublicToolchainState> {
    const resolution = await this.resolveForProject(cwd, { intent: "project-command", trusted: false });
    const state = structuredClone(this.getPublicState());
    state.projectSummary = resolution.summary.filter((line) => line.startsWith("Project "));
    for (const capability of TOOL_CAPABILITY_IDS) {
      const entry = state.capabilities[capability];
      if (!entry) continue;
      const descriptor = resolution.commands[capability];
      if (!descriptor) {
        if (entry.health === "healthy") {
          entry.provider = undefined;
          entry.version = undefined;
          entry.pathLabel = undefined;
          entry.health = "missing";
          entry.reasonCode = missingReasonForCapability(capability);
        }
        continue;
      }
      const pathLabel = redactToolPath(descriptor.executable, this.redactionRoots, this.platform);
      entry.provider = descriptor.provider;
      entry.version = descriptor.version;
      entry.pathLabel = pathLabel;
      entry.health = "healthy";
      entry.reasonCode = undefined;
      if (
        descriptor.provider === "project" &&
        !entry.candidates.some((candidate) => candidate.pathLabel === pathLabel)
      ) {
        entry.candidates.unshift({
          id: `project:${createHash("sha256").update(`${resolution.id}\0${capability}`).digest("hex").slice(0, 20)}`,
          capability,
          provider: "project",
          version: descriptor.version,
          pathLabel,
          health: "healthy",
        });
      }
    }
    return state;
  }

  async performAction(request: ToolchainActionRequest): Promise<PublicToolchainState> {
    switch (request.action) {
      case "rescan":
        return (await this.rescan()).publicState;
      case "install-component":
      case "repair-component":
        return this.installComponent(request.componentId);
      case "cancel-component-install":
        return this.cancelComponentInstall(request.componentId);
      case "install-profile": {
        const components = PROFILE_COMPONENTS[request.profileId] ?? [];
        for (const componentId of components) await this.installComponent(componentId);
        return this.getPublicState();
      }
      case "set-preference":
        if (!this.stateStore) {
          throw new ToolchainError({ code: "TOOLCHAIN_INTERNAL", message: "Toolchain state store is unavailable" });
        }
        this.persistentState = this.stateStore.update((draft) => {
          draft.preferences[request.capability] = { mode: request.preference };
        });
        this.preferences[request.capability] = request.preference;
        return (await this.rescan()).publicState;
      case "choose-custom-tool":
        throw new ToolchainError({
          code: "TOOLCHAIN_INVALID_SELECTION",
          message: "Custom tool selection must originate from the Main process file picker",
        });
      case "clear-cache":
        this.clearCache(request.cacheId);
        this.refreshPublicState();
        return this.getPublicState();
      case "remove-component":
        await this.removeComponent(request.componentId);
        return (await this.rescan()).publicState;
    }
  }

  rescan(_options: { cwd?: string } = {}): Promise<ToolchainSnapshot> {
    if (this.scanPromise) return this.scanPromise;
    this.scanPromise = this.performScan().finally(() => {
      this.scanPromise = null;
    });
    return this.scanPromise;
  }

  async registerCustomTool(capability: ToolCapabilityId, executable: string): Promise<PublicToolchainState> {
    if (!this.stateStore) {
      throw new ToolchainError({ code: "TOOLCHAIN_INTERNAL", message: "Toolchain state store is unavailable" });
    }
    const pathApi = this.platform === "win32" ? path.win32 : path.posix;
    const normalized = normalizeToolPath(executable, this.platform);
    if (
      !normalized ||
      normalized.length > 4_096 ||
      /[\0\r\n]/.test(normalized) ||
      !pathApi.isAbsolute(normalized) ||
      !this.fileSystem.isFile(normalized)
    ) {
      throw new ToolchainError({
        code: "TOOLCHAIN_INVALID_SELECTION",
        capability,
        message: "The selected tool is not an absolute executable file",
      });
    }

    const seedCapability = canonicalCustomCapability(capability);
    const seed: ExecutableSeed = {
      capability: seedCapability,
      provider: "custom",
      discovery: "user-selected",
      executable: normalized,
      argvPrefix: [],
      binDir: pathApi.dirname(normalized),
      rank: 0,
    };
    let candidates: ToolCandidate[];
    try {
      candidates = await this.probe(seed, {
        platform: this.platform,
        arch: this.arch,
        env: this.env,
        tempRoot: this.tempRoot,
        fileSystem: this.fileSystem,
        executor: this.executor,
      });
    } catch (error) {
      throw new ToolchainError({
        code: "TOOLCHAIN_INVALID_SELECTION",
        capability,
        message: "The selected executable could not be verified",
        cause: error,
      });
    }
    if (!candidates.some((candidate) => candidate.capability === capability && candidate.health === "healthy")) {
      throw new ToolchainError({
        code: "TOOLCHAIN_INVALID_SELECTION",
        capability,
        message: "The selected executable does not provide the requested healthy capability",
      });
    }

    this.persistentState = this.stateStore.update((draft) => {
      draft.custom[seedCapability] = { executable: normalized };
      for (const candidate of candidates) {
        if (candidate.health === "healthy") draft.preferences[candidate.capability] = { mode: "custom" };
      }
    });
    for (const candidate of candidates) {
      if (candidate.health === "healthy") this.preferences[candidate.capability] = "custom";
    }
    return (await this.rescan()).publicState;
  }

  subscribe(listener: (snapshot: ToolchainSnapshot) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private installComponent(componentId: ManagedComponentId): Promise<PublicToolchainState> {
    const active = this.installs.get(componentId);
    if (active) return active;
    if (!this.installer || !this.catalog) {
      return Promise.reject(
        new ToolchainError({
          code: "TOOLCHAIN_INVALID_CATALOG",
          message: `Managed ${componentId} is unavailable in this application build`,
        }),
      );
    }
    const operationId = randomUUID();
    const controller = new AbortController();
    this.installControllers.set(componentId, controller);
    this.operations.set(operationId, { operationId, componentId, phase: "queued" });
    this.refreshPublicState();
    const install = this.installer
      .install(componentId, (progress) => this.updateOperation(operationId, componentId, progress), controller.signal)
      .then(async (state) => {
        this.persistentState = state;
        return (await this.rescan()).publicState;
      })
      .finally(() => {
        this.installs.delete(componentId);
        this.installControllers.delete(componentId);
      });
    this.installs.set(componentId, install);
    return install;
  }

  private async cancelComponentInstall(componentId: ManagedComponentId): Promise<PublicToolchainState> {
    const controller = this.installControllers.get(componentId);
    const install = this.installs.get(componentId);
    if (!controller || !install) return this.getPublicState();
    controller.abort();
    try {
      await install;
    } catch (error) {
      if (!(error instanceof ToolchainError) || error.code !== "TOOLCHAIN_CANCELLED") throw error;
    }
    return this.getPublicState();
  }

  private updateOperation(operationId: string, componentId: ManagedComponentId, progress: InstallerProgress): void {
    this.operations.set(operationId, { operationId, componentId, ...progress });
    this.refreshPublicState();
  }

  private clearCache(cacheId: keyof ToolchainPaths["caches"]): void {
    const directory = this.paths?.caches[cacheId];
    if (!directory) throw new ToolchainError({ code: "TOOLCHAIN_INTERNAL", message: "Toolchain cache is unavailable" });
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    for (const name of fs.readdirSync(directory)) {
      fs.rmSync(path.join(directory, name), { recursive: true, force: true });
    }
  }

  private async removeComponent(componentId: ManagedComponentId): Promise<void> {
    if (!this.paths || !this.stateStore) {
      throw new ToolchainError({ code: "TOOLCHAIN_INTERNAL", message: "Managed runtimes are unavailable" });
    }
    if (this.installs.has(componentId)) {
      throw new ToolchainError({
        code: "TOOLCHAIN_INSTALL_BUSY",
        message: `${componentId} is currently being installed`,
      });
    }
    if (this.isRuntimeInUse()) {
      throw new ToolchainError({
        code: "TOOLCHAIN_INSTALL_BUSY",
        message: `Managed ${componentId} cannot be removed while an Agent command is running`,
      });
    }
    const componentRoot = path.join(this.paths.runtimes, componentId);
    let trashPath: string | undefined;
    if (fs.existsSync(componentRoot)) {
      fs.mkdirSync(this.paths.staging, { recursive: true, mode: 0o700 });
      trashPath = path.join(this.paths.staging, `remove-${componentId}-${randomUUID()}`);
      try {
        fs.renameSync(componentRoot, trashPath);
      } catch (error) {
        throw new ToolchainError({
          code: "TOOLCHAIN_PERMISSION_DENIED",
          message: `Managed ${componentId} is still in use or cannot be removed`,
          cause: error,
        });
      }
    }
    try {
      this.persistentState = this.stateStore.update((draft) => {
        delete draft.managed[componentId];
      });
    } catch (error) {
      if (trashPath && fs.existsSync(trashPath)) fs.renameSync(trashPath, componentRoot);
      throw error;
    }
    if (trashPath) fs.rmSync(trashPath, { recursive: true, force: true });
  }

  private pruneManagedVersionsAtStartup(): void {
    if (!this.paths || !this.stateStore) return;
    const removals: Array<{ componentId: ManagedComponentId; version: string; runtimeRoot: string }> = [];
    const retainedByComponent = new Map<ManagedComponentId, string[]>();
    for (const [componentId, activation] of Object.entries(this.persistentState.managed) as Array<
      [ManagedComponentId, NonNullable<ToolchainPersistentState["managed"][ManagedComponentId]>]
    >) {
      if (!activation) continue;
      if (activation.platformArch !== `${this.platform}-${this.arch}`) continue;
      const versions = [...new Set([...activation.installedVersions, activation.activeVersion])];
      const retained = retainedManagedVersions(componentId, activation.activeVersion, versions);
      retainedByComponent.set(componentId, retained);
      for (const version of versions) {
        if (retained.includes(version)) continue;
        removals.push({
          componentId,
          version,
          runtimeRoot: runtimeDirectory(this.paths, componentId, version, this.platform, this.arch),
        });
      }
    }
    if (removals.length === 0) return;

    fs.mkdirSync(this.paths.staging, { recursive: true, mode: 0o700 });
    const moved: Array<{ original: string; staged: string }> = [];
    try {
      for (const removal of removals) {
        if (!fs.existsSync(removal.runtimeRoot)) continue;
        const staged = path.join(
          this.paths.staging,
          `prune-${removal.componentId}-${createHash("sha256").update(removal.version).digest("hex").slice(0, 12)}-${randomUUID()}`,
        );
        fs.renameSync(removal.runtimeRoot, staged);
        moved.push({ original: removal.runtimeRoot, staged });
      }
      this.persistentState = this.stateStore.update((draft) => {
        for (const [componentId, versions] of retainedByComponent) {
          const activation = draft.managed[componentId];
          if (activation) activation.installedVersions = versions;
        }
      });
      for (const entry of moved) fs.rmSync(entry.staged, { recursive: true, force: true });
    } catch {
      for (const entry of moved.reverse()) {
        try {
          if (!fs.existsSync(entry.original) && fs.existsSync(entry.staged))
            fs.renameSync(entry.staged, entry.original);
        } catch {
          // A failed startup cleanup must not prevent discovery of the active runtime.
        }
      }
    }
  }

  async resolveForProject(cwd: string, options: ResolveProjectOptions = {}): Promise<ToolchainResolution> {
    if (!path.isAbsolute(cwd) || cwd.length > 4_096 || /[\0\r\n]/.test(cwd)) {
      throw new Error("Invalid toolchain workspace path");
    }
    const normalizedCwd = path.normalize(cwd);
    const intent = options.intent ?? "project-command";
    const trusted = options.trusted === true;
    const detected = detectProjectTools(normalizedCwd, {
      trusted,
      platform: this.platform,
      env: this.env,
    });
    const workspaceKey = createHash("sha256").update(normalizedCwd).digest("hex").slice(0, 24);
    const requirementsHash = createHash("sha256")
      .update(detected.fingerprint)
      .update("\0")
      .update(intent)
      .digest("hex")
      .slice(0, 24);
    const cacheKey = `${this.snapshot.revision}:${workspaceKey}:${requirementsHash}`;
    const cached = this.resolutionCache.get(cacheKey);
    if (cached) return cached;
    const commands = await this.resolveCommands(detected, intent);
    const summary = [...summarizeCommands(commands), ...summarizeRequirements(detected.requirements, commands)];
    const resolution: ToolchainResolution = {
      id: `r${this.snapshot.revision}-${workspaceKey}-${requirementsHash}`,
      inventoryRevision: this.snapshot.revision,
      workspaceKey,
      requirementsHash,
      commands,
      summary,
    };
    this.resolutionCache.set(cacheKey, resolution);
    return resolution;
  }

  private async resolveCommands(
    detected: DetectedProjectTools,
    intent: ExecutionIntent,
  ): Promise<ToolchainResolution["commands"]> {
    const commands = Object.fromEntries(
      Object.entries(this.snapshot.defaults).map(([capability, descriptor]) => [
        capability,
        descriptor
          ? {
              ...descriptor,
              argvPrefix: [...descriptor.argvPrefix],
              pathEntries: descriptor.pathEntries ? [...descriptor.pathEntries] : undefined,
              shellPathEntries: descriptor.shellPathEntries ? [...descriptor.shellPathEntries] : undefined,
              envPatch: { ...descriptor.envPatch },
              shellEnvPatch: descriptor.shellEnvPatch ? { ...descriptor.shellEnvPatch } : undefined,
            }
          : descriptor,
      ]),
    ) as ToolchainResolution["commands"];
    const projectAware = intent === "agent-shell" || intent === "python-script" || intent === "project-command";
    this.resolveNodeCommands(commands, projectAware ? detected.requirements.nodeRange : undefined, intent);
    await this.resolvePythonCommands(commands, detected, projectAware);
    return commands;
  }

  private resolveNodeCommands(
    commands: ToolchainResolution["commands"],
    request: string | undefined,
    intent: ExecutionIntent,
  ): void {
    const legacyNpm =
      intent === "plugin-install" && ["auto", "custom"].includes(this.preferences["js.npm"] ?? "auto")
        ? this.snapshot.candidates.find(
            (candidate) =>
              candidate.capability === "js.npm" &&
              candidate.provider === "custom" &&
              candidate.discovery === "legacy-npm-command" &&
              candidate.health === "healthy",
          )
        : undefined;
    const node = this.selectCandidate("js.node", (candidate) => nodeVersionSatisfies(candidate.version, request));
    if (!node) {
      delete commands["js.node"];
      delete commands["js.npm"];
      delete commands["js.npx"];
      if (legacyNpm) commands["js.npm"] = this.descriptor(legacyNpm);
      return;
    }
    commands["js.node"] = this.descriptor(node);
    for (const capability of ["js.npm", "js.npx"] as const) {
      const paired = this.selectCandidate(capability, (candidate) => sameComponent(node, candidate, this.platform));
      if (paired) commands[capability] = this.descriptor(paired);
      else delete commands[capability];
    }
    if (legacyNpm) commands["js.npm"] = this.descriptor(legacyNpm);
  }

  private async resolvePythonCommands(
    commands: ToolchainResolution["commands"],
    detected: DetectedProjectTools,
    projectAware: boolean,
  ): Promise<void> {
    let python: ToolCandidate | undefined;
    if (
      projectAware &&
      detected.requirements.trusted &&
      detected.pythonExecutable &&
      detected.requirements.pythonEnvironment
    ) {
      python = await this.probeProjectPython(detected);
    }
    python ??= this.selectCandidate("python.interpreter", (candidate) =>
      pythonVersionSatisfies(candidate.version, projectAware ? detected.requirements.pythonRequest : undefined),
    );
    if (python) {
      const descriptor = this.descriptor(python);
      if (python.provider === "project" && detected.requirements.pythonEnvironment) {
        descriptor.envPatch = { ...descriptor.envPatch, VIRTUAL_ENV: detected.requirements.pythonEnvironment };
      }
      if (this.paths) {
        const shimDirectory = ensurePythonShims({ paths: this.paths, descriptor, platform: this.platform });
        descriptor.pathEntries = [shimDirectory, descriptor.binDir];
      }
      commands["python.interpreter"] = descriptor;
    } else delete commands["python.interpreter"];

    const selectedPython = commands["python.interpreter"];
    for (const capability of ["python.uv", "python.uvx"] as const) {
      const descriptor = commands[capability];
      if (!descriptor || !selectedPython) continue;
      descriptor.envPatch = { ...descriptor.envPatch, UV_PYTHON: selectedPython.executable };
    }
  }

  private async probeProjectPython(detected: DetectedProjectTools): Promise<ToolCandidate | undefined> {
    const executable = detected.pythonExecutable;
    const environment = detected.requirements.pythonEnvironment;
    if (!executable || !environment || !isToolPathInside(executable, environment, this.platform)) return undefined;
    const seed: ExecutableSeed = {
      capability: "python.interpreter",
      provider: "project",
      discovery: "project-python-environment",
      executable,
      argvPrefix: [],
      binDir: (this.platform === "win32" ? path.win32 : path.posix).dirname(executable),
      rank: 0,
      componentRoot: environment,
    };
    try {
      const candidates = await this.probe(seed, {
        platform: this.platform,
        arch: this.arch,
        env: this.env,
        tempRoot: this.tempRoot,
        fileSystem: this.fileSystem,
        executor: this.executor,
      });
      const candidate = candidates.find(
        (value) =>
          value.capability === "python.interpreter" &&
          value.health === "healthy" &&
          isToolPathInside(value.executable, environment, this.platform) &&
          pythonVersionSatisfies(value.version, detected.requirements.pythonRequest),
      );
      if (!candidate) return undefined;
      return {
        ...candidate,
        provider: "project",
        discovery: "project-python-environment",
        rank: 0,
      };
    } catch {
      return undefined;
    }
  }

  private selectCandidate(
    capability: ToolCapabilityId,
    predicate: (candidate: ToolCandidate) => boolean,
  ): ToolCandidate | undefined {
    const preference = this.preferences[capability] ?? "auto";
    return this.snapshot.candidates.find(
      (candidate) =>
        candidate.capability === capability &&
        candidate.health === "healthy" &&
        (preference === "auto" || candidate.provider === preference) &&
        predicate(candidate),
    );
  }

  private descriptor(candidate: ToolCandidate): CommandDescriptor {
    return this.applyDescriptorEnvironment(commandDescriptorFromCandidate(candidate, this.platform));
  }

  private async performScan(): Promise<ToolchainSnapshot> {
    try {
      this.persistentState = this.stateStore?.load() ?? this.persistentState;
      this.preferences = Object.fromEntries(
        Object.entries(this.persistentState.preferences).map(([capability, value]) => [
          capability,
          value?.mode ?? "auto",
        ]),
      );
      const [systemSeeds, managedSeeds, bundledSeeds] = await Promise.all([
        this.registry.collect(),
        this.paths && this.catalog
          ? managedSeedsFromState({
              paths: this.paths,
              state: this.persistentState,
              catalog: this.catalog,
              platform: this.platform,
              arch: this.arch,
            })
          : Promise.resolve([]),
        this.bundledCoreRoot && this.coreCatalog
          ? bundledSeedsFromResources({
              coreRoot: this.bundledCoreRoot,
              catalog: this.coreCatalog,
              platform: this.platform,
              arch: this.arch,
            })
          : Promise.resolve([]),
      ]);
      const customSeeds = Object.entries(this.persistentState.custom).flatMap(([capability, entry]) => {
        if (!entry) return [];
        const pathApi = this.platform === "win32" ? path.win32 : path.posix;
        const executable = normalizeToolPath(entry.executable, this.platform);
        if (!pathApi.isAbsolute(executable) || !this.fileSystem.isFile(executable)) return [];
        return [
          {
            capability: capability as ToolCapabilityId,
            provider: "custom" as const,
            discovery: "user-selected",
            executable,
            argvPrefix: [],
            binDir: pathApi.dirname(executable),
            rank: 0,
          },
        ];
      });
      const seeds = [...customSeeds, ...systemSeeds, ...bundledSeeds, ...managedSeeds, ...this.legacySearchSeeds];
      const groups = await mapConcurrent(seeds, this.probeConcurrency, async (seed) => {
        try {
          return await this.probe(seed, {
            platform: this.platform,
            arch: this.arch,
            env: this.env,
            tempRoot: this.tempRoot,
            fileSystem: this.fileSystem,
            executor: this.executor,
          });
        } catch {
          return [];
        }
      });
      const candidates = normalizeAndDedupeCandidates(groups.flat(), {
        platform: this.platform,
        resolveRealPath: (value) => this.fileSystem.realpath(value),
      });
      this.snapshot = this.createSnapshot(candidates, true, this.now().toISOString());
    } catch {
      this.snapshot = this.createSnapshot([], true, this.now().toISOString(), "TOOLCHAIN_INTERNAL");
    }
    this.resolutionCache.clear();
    for (const listener of [...this.listeners]) listener(this.snapshot);
    return this.snapshot;
  }

  private createSnapshot(
    candidates: ToolCandidate[],
    scanComplete: boolean,
    lastScanAt?: string,
    lastErrorCode?: PublicToolchainState["lastErrorCode"],
  ): ToolchainSnapshot {
    const effectiveLastErrorCode = lastErrorCode ?? this.catalogLoadError;
    const selected = selectDefaultCandidates(candidates, this.preferences);
    const defaults: Partial<Record<ToolCapabilityId, CommandDescriptor>> = {};
    for (const [capability, candidate] of Object.entries(selected) as [ToolCapabilityId, ToolCandidate][]) {
      defaults[capability] = this.applyDescriptorEnvironment(commandDescriptorFromCandidate(candidate, this.platform));
    }
    const revision = this.snapshot ? this.snapshot.revision + (scanComplete ? 1 : 0) : 0;
    const generatedAt = this.now().toISOString();
    return {
      revision,
      generatedAt,
      platform: this.platform,
      arch: this.arch,
      candidates,
      defaults,
      publicState: buildPublicToolchainState({
        revision,
        platform: this.platform,
        arch: this.arch,
        candidates,
        defaults: selected,
        preferences: this.preferences,
        redactionRoots: this.redactionRoots,
        scanComplete,
        stateReadOnly: this.stateStore?.isCompatibilityReadOnly(),
        components: this.buildComponentStates(candidates),
        caches: this.buildCacheStates(),
        operations: [...this.operations.values()],
        lastScanAt,
        lastErrorCode: effectiveLastErrorCode,
      }),
    };
  }

  private refreshPublicState(): void {
    const selected = selectDefaultCandidates(this.snapshot.candidates, this.preferences);
    this.snapshot = {
      ...this.snapshot,
      publicState: buildPublicToolchainState({
        revision: this.snapshot.revision,
        platform: this.platform,
        arch: this.arch,
        candidates: this.snapshot.candidates,
        defaults: selected,
        preferences: this.preferences,
        redactionRoots: this.redactionRoots,
        scanComplete: this.snapshot.publicState.coreReady,
        stateReadOnly: this.stateStore?.isCompatibilityReadOnly(),
        components: this.buildComponentStates(this.snapshot.candidates),
        caches: this.buildCacheStates(),
        operations: [...this.operations.values()],
        lastScanAt: this.snapshot.publicState.lastScanAt,
        lastErrorCode: this.snapshot.publicState.lastErrorCode,
      }),
    };
    this.emitSnapshot();
  }

  private emitSnapshot(): void {
    for (const listener of [...this.listeners]) listener(this.snapshot);
  }

  private buildComponentStates(
    candidates: readonly ToolCandidate[],
  ): Partial<Record<ManagedComponentId, PublicManagedComponentState>> {
    const result: Partial<Record<ManagedComponentId, PublicManagedComponentState>> = {};
    for (const componentId of ["portable-git", "node-lts", "cpython", "uv", "ripgrep", "fd", "jq", "bun"] as const) {
      const activation = this.persistentState.managed[componentId];
      const component = this.catalog?.components.find((entry) => entry.id === componentId);
      const variant = component?.variants.find((entry) => entry.platform === this.platform && entry.arch === this.arch);
      const healthy = candidates.some(
        (candidate) =>
          candidate.componentId === componentId &&
          candidate.provider === "managed" &&
          candidate.health === "healthy" &&
          Boolean(
            activation &&
            this.paths &&
            candidate.componentRoot &&
            toolPathComparisonKey(candidate.componentRoot, this.platform) ===
              toolPathComparisonKey(
                runtimeDirectory(this.paths, componentId, activation.activeVersion, this.platform, this.arch),
                this.platform,
              ),
          ),
      );
      const installed = Boolean(activation);
      result[componentId] = {
        componentId,
        installed,
        activeVersion: activation?.activeVersion,
        availableVersion: component?.version,
        platformArch: variant ? `${variant.platform}-${variant.arch}` : activation?.platformArch,
        downloadBytes: variant?.downloadBytes,
        installedBytes: variant?.installedBytes,
        diskBytes: this.paths ? boundedDirectoryBytes(path.join(this.paths.runtimes, componentId)) : undefined,
        sourceName: component ? COMPONENT_SOURCE_NAMES[componentId] : undefined,
        licenseName: component?.license.name,
        licenseUrl: component?.license.url,
        health: installed
          ? healthy
            ? "healthy"
            : "modified"
          : variant
            ? "missing"
            : component
              ? "unsupported"
              : "missing",
        canInstall: Boolean(variant && (!installed || activation?.activeVersion !== component?.version)),
        canRepair: Boolean(variant && installed),
        canRemove: installed,
      };
    }
    return result;
  }

  private buildCacheStates(): PublicToolchainState["caches"] {
    if (!this.paths) return {};
    const result: Partial<Record<keyof ToolchainPaths["caches"], PublicToolchainCacheState>> = {};
    for (const cacheId of ["npm", "uv", "bun", "downloads"] as const) {
      result[cacheId] = {
        cacheId,
        diskBytes: boundedDirectoryBytes(this.paths.caches[cacheId]),
        canClear: true,
      };
    }
    return result;
  }

  private applyDescriptorEnvironment(descriptor: CommandDescriptor): CommandDescriptor {
    if (descriptor.provider !== "managed" || !this.paths) return descriptor;
    if (descriptor.componentId === "node-lts") {
      descriptor.envPatch = {
        ...descriptor.envPatch,
        npm_config_cache: this.paths.caches.npm,
        npm_config_prefix: this.paths.prefixes.npm,
      };
    } else if (descriptor.componentId === "uv") {
      descriptor.envPatch = {
        ...descriptor.envPatch,
        UV_CACHE_DIR: this.paths.caches.uv,
        UV_TOOL_DIR: this.paths.prefixes.uvTools,
        UV_TOOL_BIN_DIR: this.paths.bin,
        UV_NO_MODIFY_PATH: "1",
        UV_PYTHON_DOWNLOADS: "manual",
      };
    } else if (descriptor.componentId === "cpython") {
      descriptor.envPatch = { ...descriptor.envPatch, PIP_REQUIRE_VIRTUALENV: "true" };
    } else if (descriptor.componentId === "bun") {
      descriptor.envPatch = {
        ...descriptor.envPatch,
        BUN_INSTALL_CACHE_DIR: this.paths.caches.bun,
      };
    } else if (descriptor.componentId === "portable-git" && descriptor.componentRoot) {
      if (descriptor.capability === "vcs.git") {
        descriptor.pathEntries = portableGitNativePathEntries(descriptor.componentRoot);
      } else if (descriptor.capability === "shell.bash") {
        descriptor.shellPathEntries = portableGitShellPathEntries(descriptor.componentRoot);
        descriptor.shellEnvPatch = portableGitShellEnvPatch();
      }
    }
    return descriptor;
  }
}

function canonicalCustomCapability(capability: ToolCapabilityId): ToolCapabilityId {
  if (capability === "js.npm" || capability === "js.npx") return "js.node";
  return capability;
}

function missingReasonForCapability(capability: ToolCapabilityId): ToolchainErrorCode {
  if (["js.node", "js.npm", "js.npx"].includes(capability)) return "TOOLCHAIN_NODE_REQUIRED";
  if (capability === "python.interpreter") return "TOOLCHAIN_PYTHON_REQUIRED";
  if (capability === "python.uv" || capability === "python.uvx") return "TOOLCHAIN_UV_REQUIRED";
  if (capability === "vcs.git") return "TOOLCHAIN_GIT_REQUIRED";
  if (capability === "shell.bash") return "TOOLCHAIN_BASH_REQUIRED";
  return "TOOLCHAIN_CAPABILITY_REQUIRED";
}

function summarizeCommands(commands: ToolchainResolution["commands"]): string[] {
  const groups: ReadonlyArray<readonly [string, readonly ToolCapabilityId[]]> = [
    ["Shell", ["shell.bash", "shell.powershell"]],
    ["Git", ["vcs.git"]],
    ["JavaScript", ["js.node", "js.npm", "js.npx", "js.bun"]],
    ["Python", ["python.interpreter", "python.uv"]],
    ["Search", ["search.rg", "search.fd"]],
  ];
  const summary: string[] = [];
  for (const [label, capabilities] of groups) {
    const descriptors = capabilities.flatMap((capability) => (commands[capability] ? [commands[capability]!] : []));
    if (descriptors.length === 0) {
      summary.push(`${label}: unavailable`);
      continue;
    }
    const values = descriptors.map(
      (descriptor) =>
        `${descriptor.capability.split(".").at(-1)}${descriptor.version ? ` ${descriptor.version}` : ""} (${descriptor.provider})`,
    );
    summary.push(`${label}: ${values.join(" + ")}`);
  }
  return summary;
}

function sameComponent(left: ToolCandidate, right: ToolCandidate, platform: NodeJS.Platform): boolean {
  if (left.provider !== right.provider) return false;
  if (left.componentRoot && right.componentRoot) {
    return toolPathComparisonKey(left.componentRoot, platform) === toolPathComparisonKey(right.componentRoot, platform);
  }
  return toolPathComparisonKey(left.executable, platform) === toolPathComparisonKey(right.executable, platform);
}

function summarizeRequirements(
  requirements: ProjectToolRequirements,
  commands: ToolchainResolution["commands"],
): string[] {
  const summary: string[] = [];
  if (requirements.nodeRange) {
    const node = commands["js.node"];
    summary.push(
      node
        ? `Project Node: ${requirements.nodeRange} → ${node.version ?? "compatible"}`
        : `Project Node: ${requirements.nodeRange} → unavailable`,
    );
  }
  if (requirements.packageManager) summary.push(`Project package manager: ${requirements.packageManager}`);
  if (requirements.pythonRequest) {
    const python = commands["python.interpreter"];
    summary.push(
      python
        ? `Project Python: ${requirements.pythonRequest} → ${python.version ?? "compatible"}`
        : `Project Python: ${requirements.pythonRequest} → unavailable`,
    );
  }
  if (requirements.markers.includes("python-environment-blocked")) {
    summary.push("Project Python environment: blocked until the project is trusted");
  } else if (commands["python.interpreter"]?.provider === "project") {
    summary.push("Project Python environment: active");
  }
  return summary;
}

export function retainedManagedVersions(
  componentId: ManagedComponentId,
  activeVersion: string,
  installedVersions: readonly string[],
): string[] {
  const ordered = [...new Set([...installedVersions, activeVersion])];
  const nonActiveNewestFirst = ordered.filter((version) => version !== activeVersion).reverse();
  if (componentId !== "cpython") {
    return [activeVersion, ...nonActiveNewestFirst.slice(0, 1)];
  }

  const activeMinor = pythonMinor(activeVersion);
  const retained = [activeVersion];
  const seenMinor = new Set<string>([activeMinor]);
  let sameMinorRollback = false;
  for (const version of nonActiveNewestFirst) {
    const minor = pythonMinor(version);
    if (minor === activeMinor) {
      if (!sameMinorRollback) {
        retained.push(version);
        sameMinorRollback = true;
      }
      continue;
    }
    if (seenMinor.has(minor)) continue;
    seenMinor.add(minor);
    retained.push(version);
  }
  return retained;
}

function pythonMinor(version: string): string {
  return version.match(/^(\d+\.\d+)/)?.[1] ?? version;
}
