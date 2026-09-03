import { createHash } from "node:crypto";
import { access, realpath, stat } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import semver from "semver";
import { loadHerdrRuntimeCatalog, type HerdrRuntimeCatalog } from "./catalog";
import { HerdrInstaller } from "./installer";
import {
  HerdrManagedServerError,
  HerdrManagedServerSupervisor,
  type HerdrManagedServerEvent,
  type HerdrManagedServerTarget,
} from "./managed-server";
import type { PublicManagedComponentState } from "../../shared/toolchains/types.ts";
import type { InstallerProgress } from "../toolchains/installer.ts";
import {
  DEFAULT_HERDR_SETTINGS,
  HERDR_MAX_VERSION_EXCLUSIVE,
  HERDR_MIN_VERSION,
  HERDR_PROTOCOL_VERSION,
  HERDR_SCHEMA_VERSION,
  isHerdrSettings,
  normalizeHerdrSettings,
  type HerdrBinarySource,
  type HerdrPublicError,
  type HerdrRuntimeDescriptor,
  type HerdrSettings,
} from "../../contract/herdr";

const PROBE_TIMEOUT_MS = 5_000;
const PROBE_TOTAL_TIMEOUT_MS = 10_000;
const PROBE_OUTPUT_LIMIT = 4 * 1024 * 1024;
const PROBE_STDERR_LIMIT = 64 * 1024;

type RuntimeManagerOptions = {
  userDataDir: string;
  platform?: NodeJS.Platform;
  arch?: string;
  env?: NodeJS.ProcessEnv;
  catalogPath?: string;
  bundledRoot?: string;
  installer?: {
    inspect(): PublicManagedComponentState;
    install(onProgress?: (progress: InstallerProgress) => void, signal?: AbortSignal): Promise<string>;
    remove(): Promise<void>;
  };
  serverSupervisor?: {
    setListener(listener: (event: HerdrManagedServerEvent) => void): void;
    ensureRunning(target: HerdrManagedServerTarget): Promise<void>;
    stop(): Promise<void>;
  };
  probe?: (executable: string) => Promise<ProbeResult>;
  log?: (message: string) => void;
};

type ProbeResult = { version: string; protocol: number; schemaVersion: number; schemaSha256: string };

const UNAVAILABLE_CATALOG: HerdrRuntimeCatalog = {
  schemaVersion: 1,
  version: "0.8.2",
  protocol: 20,
  apiSchemaVersion: 1,
  apiSchemaSha256: "0".repeat(64),
  license: "Apache-2.0",
  artifacts: {},
};

function publicError(
  code: HerdrPublicError["code"],
  message: string,
  retryable: boolean,
  upgradeRequired = false,
  options: Pick<HerdrPublicError, "action" | "detail"> = {},
): HerdrPublicError {
  return {
    code,
    message,
    retryable,
    ...(options.action ? { action: options.action } : {}),
    ...(options.detail ? { detail: options.detail } : {}),
    ...(upgradeRequired ? { upgradeRequired: true } : {}),
  };
}

function cleanSettings(value: unknown): HerdrSettings {
  return normalizeHerdrSettings(value);
}

function executableName(platform: NodeJS.Platform): string {
  return platform === "win32" ? "herdr.exe" : "herdr";
}

function splitPath(value: string | undefined, platform: NodeJS.Platform): string[] {
  if (!value) return [];
  return value.split(platform === "win32" ? ";" : ":").filter(Boolean);
}

async function isExecutableFile(filePath: string, platform: NodeJS.Platform): Promise<boolean> {
  try {
    const info = await stat(filePath);
    if (!info.isFile()) return false;
    if (platform !== "win32") await access(filePath, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function runProbeCommand(executable: string, args: string[], timeoutMs = PROBE_TIMEOUT_MS): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let stdout: Buffer<ArrayBufferLike> = Buffer.alloc(0);
    let stderrBytes = 0;
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(stdout.toString("utf8"));
    };
    const appendStdout = (current: Buffer<ArrayBufferLike>, chunk: Buffer<ArrayBufferLike>) => {
      if (current.length + chunk.length > PROBE_OUTPUT_LIMIT) {
        try {
          child.kill("SIGKILL");
        } catch {
          /* child already exited */
        }
        finish(new Error("Herdr probe output exceeded the safety limit"));
        return current;
      }
      return Buffer.concat([current, chunk]);
    };
    child.stdout.on("data", (chunk: Buffer) => {
      stdout = appendStdout(stdout, chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderrBytes += chunk.length;
      if (stderrBytes > PROBE_STDERR_LIMIT) {
        try {
          child.kill("SIGKILL");
        } catch {
          /* child already exited */
        }
        finish(new Error("Herdr probe stderr exceeded the safety limit"));
      }
    });
    child.once("error", (error) => finish(error));
    // `exit` can fire before stdout/stderr pipes have drained. Wait for `close`
    // so fast probes such as `herdr --version` cannot resolve with empty output.
    child.once("close", (code, signal) => {
      if (code === 0) finish();
      else finish(new Error(`Herdr probe exited unsuccessfully (${code ?? signal ?? "unknown"})`));
    });
    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        /* child already exited */
      }
      finish(new Error("Herdr probe timed out"));
    }, timeoutMs);
    timer.unref();
  });
}

export async function probeHerdrExecutable(executable: string): Promise<ProbeResult> {
  const deadline = Date.now() + PROBE_TOTAL_TIMEOUT_MS;
  const remaining = () => Math.max(1, Math.min(PROBE_TIMEOUT_MS, deadline - Date.now()));
  const versionOutput = await runProbeCommand(executable, ["--version"], remaining());
  const versionMatch = versionOutput.match(/(?:herdr\s+)?v?(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)/i);
  if (!versionMatch) throw new Error("Herdr did not report a valid semantic version");
  const version = versionMatch[1];

  if (Date.now() >= deadline) throw new Error("Herdr probe timed out");
  const schemaOutput = await runProbeCommand(executable, ["api", "schema", "--json"], remaining());
  const normalizedSchema = `${schemaOutput.replace(/\r\n/g, "\n").trimEnd()}\n`;
  let schema: unknown;
  try {
    schema = JSON.parse(normalizedSchema);
  } catch {
    throw new Error("Herdr returned invalid API schema JSON");
  }
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) throw new Error("Herdr API schema is invalid");
  const record = schema as Record<string, unknown>;
  if (!Number.isSafeInteger(record.protocol) || !Number.isSafeInteger(record.schema_version)) {
    throw new Error("Herdr API schema is missing protocol metadata");
  }
  return {
    version,
    protocol: Number(record.protocol),
    schemaVersion: Number(record.schema_version),
    schemaSha256: createHash("sha256").update(normalizedSchema).digest("hex"),
  };
}

function safeProbeMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : "";
  if (message.includes("timed out")) return "Herdr executable probe timed out.";
  if (message.includes("safety limit")) return "Herdr executable probe exceeded an output safety limit.";
  if (message.includes("semantic version")) return "Herdr did not report a valid semantic version.";
  if (message.includes("invalid API schema JSON")) return "Herdr returned invalid API schema JSON.";
  if (message.includes("API schema is invalid")) return "Herdr API schema is invalid.";
  if (message.includes("missing protocol metadata")) return "Herdr API schema is missing protocol metadata.";
  return "Herdr executable probe failed.";
}

export class HerdrRuntimeManager {
  private readonly platform: NodeJS.Platform;
  private readonly arch: string;
  private readonly env: NodeJS.ProcessEnv;
  private settings: HerdrSettings = structuredClone(DEFAULT_HERDR_SETTINGS);
  private descriptor: HerdrRuntimeDescriptor = {
    revision: 0,
    enabled: false,
    mode: "attach",
    sessionName: "default",
    autoConnect: true,
    releaseControlOnViewClose: true,
  };
  private listener: ((descriptor: HerdrRuntimeDescriptor) => void) | null = null;
  private readonly installer: {
    inspect(): PublicManagedComponentState;
    install(onProgress?: (progress: InstallerProgress) => void, signal?: AbortSignal): Promise<string>;
    remove(): Promise<void>;
  };
  private readonly catalog: HerdrRuntimeCatalog;
  private readonly catalogLoadFailed: boolean;
  private readonly serverSupervisor: NonNullable<RuntimeManagerOptions["serverSupervisor"]>;
  private readonly probe: NonNullable<RuntimeManagerOptions["probe"]>;
  private operationTail: Promise<void> = Promise.resolve();
  private installPromise: Promise<HerdrRuntimeDescriptor> | null = null;
  private managedServerSuspended = false;

  constructor(private readonly options: RuntimeManagerOptions) {
    this.platform = options.platform ?? process.platform;
    this.arch = options.arch ?? process.arch;
    this.env = options.env ?? process.env;
    const catalogPath = options.catalogPath ?? path.resolve("build/herdr/runtime-catalog.json");
    let catalog: HerdrRuntimeCatalog;
    let catalogLoadFailed = false;
    try {
      catalog = loadHerdrRuntimeCatalog(catalogPath);
    } catch {
      catalog = UNAVAILABLE_CATALOG;
      catalogLoadFailed = true;
      options.log?.("Herdr runtime catalog failed validation; integration remains disabled");
    }
    this.catalog = catalog;
    this.catalogLoadFailed = catalogLoadFailed;
    this.probe = options.probe ?? probeHerdrExecutable;
    this.installer =
      options.installer ??
      new HerdrInstaller({
        userDataDir: options.userDataDir,
        catalogPath,
        bundledRoot: options.bundledRoot ?? path.resolve("build/herdr/bin", `${this.platform}-${this.arch}`),
        platform: this.platform,
        arch: this.arch,
        probe: this.probe,
        catalog,
      });
    this.serverSupervisor =
      options.serverSupervisor ?? new HerdrManagedServerSupervisor({ env: this.env, log: options.log });
    this.serverSupervisor.setListener((event) => this.handleManagedServerEvent(event));
  }

  setListener(listener: (descriptor: HerdrRuntimeDescriptor) => void): void {
    this.listener = listener;
  }

  getDescriptor(): HerdrRuntimeDescriptor {
    return structuredClone(this.descriptor);
  }

  getSettings(): HerdrSettings {
    return structuredClone(this.settings);
  }

  async configure(value: unknown): Promise<HerdrRuntimeDescriptor> {
    if (!isHerdrSettings(value)) throw new Error("Invalid Herdr settings");
    const settings = cleanSettings(value);
    return this.enqueueOperation(async () => {
      this.settings = settings;
      return this.refreshSettings(settings);
    });
  }

  async initialize(value: unknown): Promise<HerdrRuntimeDescriptor> {
    const settings = cleanSettings(value);
    return this.enqueueOperation(async () => {
      this.settings = settings;
      return this.refreshSettings(settings);
    });
  }

  initializeInBackground(value: unknown): Promise<HerdrRuntimeDescriptor> {
    const initial = this.prepare(value);
    const settings = structuredClone(this.settings);
    if (!settings.enabled) return Promise.resolve(initial);
    return this.enqueueOperation(() => this.refreshSettings(settings));
  }

  prepare(value: unknown): HerdrRuntimeDescriptor {
    const settings = cleanSettings(value);
    this.settings = settings;
    return this.publish({ ...this.baseDescriptor(settings), ...(settings.enabled ? { probing: true } : {}) });
  }

  async refresh(): Promise<HerdrRuntimeDescriptor> {
    return this.enqueueOperation(() => this.refreshSettings(structuredClone(this.settings)));
  }

  getManagedComponentState(): PublicManagedComponentState {
    if (this.catalogLoadFailed) {
      return {
        componentId: "herdr",
        installed: false,
        availableVersion: HERDR_MIN_VERSION,
        health: "broken",
        canInstall: false,
        canRepair: false,
        canRemove: false,
      };
    }
    return this.installer.inspect();
  }

  async installManagedRuntime(
    onProgress?: (progress: InstallerProgress) => void,
    signal?: AbortSignal,
  ): Promise<HerdrRuntimeDescriptor> {
    if (this.installPromise) return this.installPromise;
    const promise = this.enqueueOperation(async () => {
      const settings = structuredClone(this.settings);
      if (this.platform === "win32") return this.publish(this.unsupportedPlatformDescriptor(settings));
      await this.serverSupervisor.stop();
      try {
        await this.installer.install(onProgress, signal);
      } catch (error) {
        await this.refreshSettings(settings).catch(() => undefined);
        throw error;
      }
      return this.refreshSettings(settings);
    });
    this.installPromise = promise;
    try {
      return await promise;
    } finally {
      if (this.installPromise === promise) this.installPromise = null;
    }
  }

  async removeManagedRuntime(): Promise<HerdrRuntimeDescriptor> {
    return this.enqueueOperation(async () => {
      await this.serverSupervisor.stop();
      await this.installer.remove();
      return this.refreshSettings(structuredClone(this.settings));
    });
  }

  async stopManagedServer(): Promise<void> {
    this.managedServerSuspended = true;
    await this.serverSupervisor.stop();
  }

  private enqueueOperation<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.operationTail.then(operation, operation);
    this.operationTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private async refreshSettings(settings: HerdrSettings): Promise<HerdrRuntimeDescriptor> {
    const base = this.baseDescriptor(settings);
    if (!settings.enabled) {
      await this.serverSupervisor.stop();
      return this.publish(base);
    }
    if (this.platform === "win32") {
      await this.serverSupervisor.stop();
      return this.publish(this.unsupportedPlatformDescriptor(settings));
    }
    if (this.catalogLoadFailed) {
      await this.serverSupervisor.stop();
      return this.publish({
        ...base,
        error: publicError(
          "HERDR_BINARY_INTEGRITY_FAILED",
          "This Pi Desktop build does not contain a valid Herdr runtime catalog.",
          false,
        ),
      });
    }

    if (settings.mode === "managed") {
      let managedState: PublicManagedComponentState;
      try {
        managedState = this.installer.inspect();
      } catch {
        await this.serverSupervisor.stop();
        return this.publish({
          ...base,
          error: publicError(
            "HERDR_BINARY_INTEGRITY_FAILED",
            "The managed Herdr runtime could not be verified. Repair it in Developer Tools.",
            false,
          ),
        });
      }
      if (!managedState.installed) {
        await this.serverSupervisor.stop();
        return this.publish({
          ...base,
          error: publicError(
            "HERDR_BINARY_NOT_FOUND",
            "The managed Herdr runtime is not installed. Open Developer Tools to install it.",
            true,
          ),
        });
      }
      if (managedState.health !== "healthy" || managedState.activeVersion !== this.catalog.version) {
        await this.serverSupervisor.stop();
        return this.publish({
          ...base,
          error: publicError(
            "HERDR_BINARY_INTEGRITY_FAILED",
            "The managed Herdr runtime was modified or is incomplete. Repair it in Developer Tools.",
            false,
          ),
        });
      }
    }

    const candidate = await this.resolveExecutable(settings);
    if (!candidate) {
      await this.serverSupervisor.stop();
      return this.publish({
        ...base,
        error: publicError(
          "HERDR_BINARY_NOT_FOUND",
          settings.mode === "managed"
            ? "The managed Herdr runtime is not installed. Open Developer Tools to install it."
            : "Herdr was not found on the system PATH.",
          true,
        ),
      });
    }

    try {
      const probe = await this.probe(candidate.executable);
      const compatibilityError = this.compatibilityError(probe, candidate.source);
      const descriptor = {
        ...base,
        executable: candidate.executable,
        endpoint: this.resolveEndpoint(settings.sessionName),
        binarySource: candidate.source,
        ...probe,
        ...(compatibilityError ? { error: compatibilityError } : {}),
      };
      if (compatibilityError || settings.mode === "attach") {
        await this.serverSupervisor.stop();
        return this.publish(descriptor);
      }
      if (this.managedServerSuspended) {
        await this.serverSupervisor.stop();
        return this.publish(descriptor);
      }
      try {
        await this.serverSupervisor.ensureRunning({
          executable: candidate.executable,
          sessionName: settings.sessionName,
          endpoint: descriptor.endpoint,
        });
        return this.publish(descriptor);
      } catch (error) {
        return this.publish({ ...descriptor, error: this.managedServerError(error) });
      }
    } catch (error) {
      await this.serverSupervisor.stop();
      return this.publish({
        ...base,
        executable: candidate.executable,
        binarySource: candidate.source,
        error: publicError("HERDR_BINARY_NOT_EXECUTABLE", safeProbeMessage(error), true),
      });
    }
  }

  private baseDescriptor(settings: HerdrSettings): Omit<HerdrRuntimeDescriptor, "revision"> {
    return {
      enabled: settings.enabled,
      mode: settings.mode,
      sessionName: settings.sessionName,
      autoConnect: settings.autoConnect,
      releaseControlOnViewClose: settings.releaseControlOnViewClose,
    };
  }

  private unsupportedPlatformDescriptor(settings: HerdrSettings): Omit<HerdrRuntimeDescriptor, "revision"> {
    return {
      ...this.baseDescriptor(settings),
      error: publicError(
        "HERDR_PLATFORM_UNSUPPORTED",
        "Herdr integration is not supported on Windows in this release.",
        false,
      ),
    };
  }

  private publish(descriptor: Omit<HerdrRuntimeDescriptor, "revision">): HerdrRuntimeDescriptor {
    this.descriptor = structuredClone({ ...descriptor, revision: this.descriptor.revision + 1 });
    this.listener?.(this.getDescriptor());
    return this.getDescriptor();
  }

  private compatibilityError(probe: ProbeResult, source: HerdrBinarySource): HerdrPublicError | undefined {
    if (probe.protocol !== HERDR_PROTOCOL_VERSION) {
      return publicError(
        "HERDR_PROTOCOL_UNSUPPORTED",
        "The Herdr protocol is incompatible with this Pi Desktop release.",
        false,
        probe.protocol < HERDR_PROTOCOL_VERSION,
        {
          action: probe.protocol < HERDR_PROTOCOL_VERSION ? "upgrade" : "configure",
          detail: { requiredProtocol: HERDR_PROTOCOL_VERSION, actualProtocol: probe.protocol },
        },
      );
    }
    if (semver.lt(probe.version, HERDR_MIN_VERSION)) {
      return publicError(
        "HERDR_VERSION_TOO_OLD",
        `Herdr ${probe.version} is too old; Pi Desktop requires ${HERDR_MIN_VERSION}.`,
        false,
        true,
        {
          action: "upgrade",
          detail: { requiredVersion: HERDR_MIN_VERSION, actualVersion: probe.version },
        },
      );
    }
    if (!semver.lt(probe.version, HERDR_MAX_VERSION_EXCLUSIVE)) {
      return publicError(
        "HERDR_VERSION_UNSUPPORTED",
        `Herdr ${probe.version} has not been validated by this Pi Desktop adapter.`,
        false,
      );
    }
    if (probe.schemaVersion !== HERDR_SCHEMA_VERSION) {
      return publicError(
        "HERDR_SCHEMA_UNSUPPORTED",
        `Herdr API schema ${probe.schemaVersion} is incompatible; schema ${HERDR_SCHEMA_VERSION} is required.`,
        false,
      );
    }
    // Managed binaries are pinned byte-for-byte to the catalog schema. Attach/custom
    // binaries use protocol + schema-version compatibility so locally built 0.8.x
    // binaries remain usable without weakening the managed supply-chain boundary.
    if (source === "managed" && probe.schemaSha256 !== this.catalog.apiSchemaSha256) {
      return publicError(
        "HERDR_SCHEMA_UNSUPPORTED",
        "The managed Herdr API schema does not match the pinned Pi Desktop catalog.",
        false,
      );
    }
    return undefined;
  }

  private async resolveExecutable(
    settings: HerdrSettings,
  ): Promise<{ executable: string; source: HerdrBinarySource } | null> {
    const managed = path.join(
      this.options.userDataDir,
      "herdr",
      "runtimes",
      this.catalog.version,
      `${this.platform}-${this.arch}`,
      executableName(this.platform),
    );
    if (settings.mode === "managed") return this.validateCandidate(managed, "managed");

    const systemCandidates = splitPath(this.env.PATH, this.platform).map((directory) =>
      path.join(directory, executableName(this.platform)),
    );
    for (const candidate of [...new Set(systemCandidates)]) {
      const validated = await this.validateCandidate(candidate, "system");
      if (validated) return validated;
    }
    return null;
  }

  private async validateCandidate(
    requested: string,
    source: HerdrBinarySource,
  ): Promise<{ executable: string; source: HerdrBinarySource } | null> {
    if (!(await isExecutableFile(requested, this.platform))) return null;
    try {
      return { executable: await realpath(requested), source };
    } catch {
      return null;
    }
  }

  private resolveEndpoint(sessionName: string): string {
    const appDir = "herdr";
    let configRoot: string;
    if (this.env.XDG_CONFIG_HOME) configRoot = path.join(this.env.XDG_CONFIG_HOME, appDir);
    else if (this.platform === "win32") {
      configRoot = path.join(
        this.env.APPDATA ||
          (this.env.USERPROFILE
            ? path.join(this.env.USERPROFILE, "AppData", "Roaming")
            : path.join(homedir(), ".config")),
        appDir,
      );
    } else configRoot = path.join(homedir(), ".config", appDir);
    const sessionRoot = sessionName === "default" ? configRoot : path.join(configRoot, "sessions", sessionName);
    return path.join(sessionRoot, "herdr.sock");
  }

  private handleManagedServerEvent(event: HerdrManagedServerEvent): void {
    const settings = structuredClone(this.settings);
    if (!settings.enabled || settings.mode !== "managed" || event.target?.sessionName !== settings.sessionName) return;
    if (event.state === "running") {
      if (!this.descriptor.error?.code.startsWith("HERDR_SERVER_")) return;
      void this.enqueueOperation(() => this.refreshSettings(structuredClone(this.settings)));
      return;
    }
    if (event.state !== "failed" || !event.failure) return;
    void this.enqueueOperation(async () => {
      const current = this.settings;
      if (!current.enabled || current.mode !== "managed" || event.target?.sessionName !== current.sessionName) return;
      this.publish({
        ...this.descriptor,
        error: this.managedServerError(new HerdrManagedServerError(event.failure!, "Managed Herdr server failed.")),
      });
    });
  }

  private managedServerError(error: unknown): HerdrPublicError {
    const failure = error instanceof HerdrManagedServerError ? error.failure : "start-failed";
    if (failure === "conflict") {
      return publicError(
        "HERDR_SERVER_CONFLICT",
        "This Herdr Session is already running outside Pi Desktop. Stop it or use Attach mode.",
        false,
      );
    }
    if (failure === "restart-exhausted") {
      return publicError(
        "HERDR_SERVER_RESTART_EXHAUSTED",
        "The managed Herdr server repeatedly exited and automatic restart was stopped.",
        true,
      );
    }
    return publicError("HERDR_SERVER_START_FAILED", "The managed Herdr server could not be started.", true);
  }
}

export const __test = { probeHerdrExecutable, runProbeCommand };
