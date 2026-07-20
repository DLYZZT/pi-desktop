import { execFile, spawn, type ChildProcess, type ExecFileOptions } from "node:child_process";
import { promisify } from "node:util";
import type {
  CommandDescriptor,
  ExecutionContextRequest,
  ExecutionIntent,
  ToolCapabilityId,
  ToolExecutionContext,
  ToolchainResolution,
  ToolchainSnapshot,
} from "../shared/toolchains/types";
import { ToolchainError } from "../shared/toolchains/errors.ts";
import { callMain } from "./parent-rpc.ts";
import { windowsNativePathToMsys } from "../main/toolchains/environment.ts";

const execFileAsync = promisify(execFile);
const ENV_COMMAND_ORDER: readonly ToolCapabilityId[] = [
  "shell.bash",
  "shell.powershell",
  "vcs.git",
  "js.node",
  "js.npm",
  "js.npx",
  "js.bun",
  "python.interpreter",
  "python.uv",
  "python.uvx",
  "search.rg",
  "search.fd",
  "data.jq",
  "network.curl",
];

export interface ToolchainRuntimeOptions {
  platform?: NodeJS.Platform;
  baseEnv?: NodeJS.ProcessEnv;
  fetchSnapshot?: () => Promise<ToolchainSnapshot>;
  resolveProject?: (cwd: string, intent: ExecutionIntent, trusted: boolean) => Promise<ToolchainResolution>;
}

export interface SpawnResolvedOptions {
  cwd: string;
  intent: ExecutionIntent;
  env?: NodeJS.ProcessEnv;
  stdio?: "pipe" | "ignore" | "inherit";
  windowsHide?: boolean;
  trusted?: boolean;
}

export interface ExecuteFromContextOptions {
  cwd: string;
  env?: NodeJS.ProcessEnv;
  timeout?: number;
  maxBuffer?: number;
  encoding?: BufferEncoding;
}

function cloneDescriptor(descriptor: CommandDescriptor): CommandDescriptor {
  return {
    ...descriptor,
    argvPrefix: [...descriptor.argvPrefix],
    pathEntries: descriptor.pathEntries ? [...descriptor.pathEntries] : undefined,
    shellPathEntries: descriptor.shellPathEntries ? [...descriptor.shellPathEntries] : undefined,
    envPatch: { ...descriptor.envPatch },
    shellEnvPatch: descriptor.shellEnvPatch ? { ...descriptor.shellEnvPatch } : undefined,
  };
}

function cloneResolution(resolution: ToolchainResolution): ToolchainResolution {
  return {
    ...resolution,
    commands: Object.fromEntries(
      Object.entries(resolution.commands).map(([capability, descriptor]) => [
        capability,
        descriptor ? cloneDescriptor(descriptor) : descriptor,
      ]),
    ),
    summary: [...resolution.summary],
  };
}

function pathEnvironmentKey(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): string {
  if (platform !== "win32") return "PATH";
  return Object.keys(env).find((key) => key.toLowerCase() === "path") ?? "Path";
}

function pathKey(value: string, platform: NodeJS.Platform): string {
  return platform === "win32" ? value.toLocaleLowerCase("en-US") : value;
}

function prependPath(
  env: NodeJS.ProcessEnv,
  directories: readonly string[],
  platform: NodeJS.Platform,
): NodeJS.ProcessEnv {
  const result = { ...env };
  const key = pathEnvironmentKey(result, platform);
  const delimiter = platform === "win32" ? ";" : ":";
  const existing = (result[key] ?? "").split(delimiter).filter(Boolean);
  const seen = new Set<string>();
  const values: string[] = [];
  for (const entry of [...directories, ...existing]) {
    const normalized = pathKey(entry, platform);
    if (!entry || seen.has(normalized)) continue;
    seen.add(normalized);
    values.push(entry);
  }
  result[key] = values.join(delimiter);
  if (platform === "win32") {
    for (const existingKey of Object.keys(result)) {
      if (existingKey !== key && existingKey.toLowerCase() === "path") delete result[existingKey];
    }
  }
  return result;
}

function missingCapabilityError(capability: ToolCapabilityId): ToolchainError {
  const code =
    capability.startsWith("js.") && capability !== "js.bun"
      ? "TOOLCHAIN_NODE_REQUIRED"
      : capability === "python.interpreter"
        ? "TOOLCHAIN_PYTHON_REQUIRED"
        : capability === "python.uv" || capability === "python.uvx"
          ? "TOOLCHAIN_UV_REQUIRED"
          : capability === "vcs.git"
            ? "TOOLCHAIN_GIT_REQUIRED"
            : capability === "shell.bash"
              ? "TOOLCHAIN_BASH_REQUIRED"
              : "TOOLCHAIN_CAPABILITY_REQUIRED";
  return new ToolchainError({
    code,
    capability,
    message: `Required tool capability is unavailable: ${capability}`,
  });
}

export class ToolchainRuntime {
  private readonly platform: NodeJS.Platform;
  private readonly baseEnv: NodeJS.ProcessEnv;
  private readonly fetchSnapshot: () => Promise<ToolchainSnapshot>;
  private readonly resolveProject: (
    cwd: string,
    intent: ExecutionIntent,
    trusted: boolean,
  ) => Promise<ToolchainResolution>;
  private snapshot: ToolchainSnapshot | null = null;
  private readonly resolutions = new Map<string, ToolchainResolution>();
  private readonly resolutionByRequest = new Map<string, ToolchainResolution>();

  constructor(options: ToolchainRuntimeOptions = {}) {
    this.platform = options.platform ?? process.platform;
    this.baseEnv = { ...(options.baseEnv ?? process.env) };
    this.fetchSnapshot =
      options.fetchSnapshot ?? (() => callMain<ToolchainSnapshot>("toolchain.getSnapshot", undefined, 15_000));
    this.resolveProject =
      options.resolveProject ??
      ((cwd, intent, trusted) => callMain<ToolchainResolution>("toolchain.resolve", { cwd, intent, trusted }, 15_000));
  }

  apply(snapshot: ToolchainSnapshot): boolean {
    if (!snapshot || !Number.isSafeInteger(snapshot.revision) || snapshot.revision < 0) {
      throw new ToolchainError({ code: "TOOLCHAIN_INTERNAL", message: "Invalid toolchain snapshot" });
    }
    if (this.snapshot && snapshot.revision < this.snapshot.revision) return false;
    const revisionChanged = this.snapshot?.revision !== snapshot.revision;
    this.snapshot = structuredClone(snapshot);
    if (revisionChanged) {
      this.resolutions.clear();
      this.resolutionByRequest.clear();
    }
    return true;
  }

  peekSnapshot(): ToolchainSnapshot | null {
    return this.snapshot ? structuredClone(this.snapshot) : null;
  }

  getSnapshot(): ToolchainSnapshot {
    if (!this.snapshot) {
      throw new ToolchainError({ code: "TOOLCHAIN_INTERNAL", message: "Toolchain snapshot is not initialized" });
    }
    return structuredClone(this.snapshot);
  }

  applyResolution(resolution: ToolchainResolution): void {
    if (!this.snapshot || resolution.inventoryRevision !== this.snapshot.revision) {
      throw new ToolchainError({
        code: "TOOLCHAIN_INTERNAL",
        message: "Toolchain resolution does not match the active inventory revision",
      });
    }
    const cloned = cloneResolution(resolution);
    this.resolutions.set(cloned.workspaceKey, cloned);
  }

  async prepare(cwd: string, intent: ExecutionIntent, trusted = false): Promise<ToolchainResolution> {
    if (!this.snapshot) this.apply(await this.fetchSnapshot());
    const requestKey = `${cwd}\0${intent}\0${trusted ? "trusted" : "untrusted"}\0${this.snapshot!.revision}`;
    const cached = this.resolutionByRequest.get(requestKey);
    if (cached) return cloneResolution(cached);

    let resolution = await this.resolveProject(cwd, intent, trusted);
    if (resolution.inventoryRevision !== this.snapshot!.revision) {
      this.apply(await this.fetchSnapshot());
      resolution = await this.resolveProject(cwd, intent, trusted);
    }
    this.applyResolution(resolution);
    const cloned = cloneResolution(resolution);
    this.resolutionByRequest.set(requestKey, cloned);
    return cloneResolution(cloned);
  }

  require(capability: ToolCapabilityId, resolution: ToolchainResolution): CommandDescriptor {
    const descriptor = resolution.commands[capability];
    if (!descriptor) throw missingCapabilityError(capability);
    return cloneDescriptor(descriptor);
  }

  async createExecutionContext(request: ExecutionContextRequest): Promise<ToolExecutionContext> {
    const resolution = await this.prepare(request.cwd, request.intent, request.trusted === true);
    const nativeDirectories: string[] = [];
    const shellDirectories: string[] = [];
    for (const capability of ENV_COMMAND_ORDER) {
      const descriptor = resolution.commands[capability];
      if (!descriptor) continue;
      const shellOnly = descriptor.capability === "shell.bash" && descriptor.cwdSemantics === "msys";
      if (descriptor.pathEntries) {
        shellDirectories.push(...descriptor.pathEntries);
        if (!shellOnly) nativeDirectories.push(...descriptor.pathEntries);
      }
      if (descriptor.binDir) {
        shellDirectories.push(descriptor.binDir);
        if (!shellOnly) nativeDirectories.push(descriptor.binDir);
      }
      if (descriptor.shellPathEntries) shellDirectories.push(...descriptor.shellPathEntries);
    }
    let nativeEnv = prependPath(this.baseEnv, nativeDirectories, this.platform);
    for (const capability of ENV_COMMAND_ORDER) {
      const descriptor = resolution.commands[capability];
      if (descriptor) nativeEnv = { ...nativeEnv, ...descriptor.envPatch };
    }
    nativeEnv.PI_DESKTOP_TOOLCHAIN_REVISION = String(resolution.inventoryRevision);
    nativeEnv.PI_DESKTOP_TOOLCHAIN_RESOLUTION = resolution.id;
    let shellEnv = prependPath(nativeEnv, shellDirectories, this.platform);
    for (const capability of ENV_COMMAND_ORDER) {
      const descriptor = resolution.commands[capability];
      if (descriptor?.shellEnvPatch) shellEnv = { ...shellEnv, ...descriptor.shellEnvPatch };
    }
    const shell = resolution.commands["shell.bash"];
    if (this.platform === "win32" && shell?.cwdSemantics === "msys") {
      shellEnv.PI_DESKTOP_SHELL_CWD_SEMANTICS = "msys";
      const workspace = windowsNativePathToMsys(request.cwd);
      if (workspace) shellEnv.PI_DESKTOP_WORKSPACE_MSYS_PATH = workspace;
    }
    return {
      inventoryRevision: resolution.inventoryRevision,
      resolutionId: resolution.id,
      nativeEnv,
      shellEnv,
      commands: Object.fromEntries(
        Object.entries(resolution.commands).map(([capability, descriptor]) => [
          capability,
          descriptor ? cloneDescriptor(descriptor) : descriptor,
        ]),
      ),
      summary: [...resolution.summary],
    };
  }

  requireFromContext(capability: ToolCapabilityId, context: ToolExecutionContext): CommandDescriptor {
    const descriptor = context.commands[capability];
    if (!descriptor) throw missingCapabilityError(capability);
    return cloneDescriptor(descriptor);
  }

  async exec(
    capability: ToolCapabilityId,
    args: string[],
    options: {
      cwd: string;
      intent: ExecutionIntent;
      env?: NodeJS.ProcessEnv;
      timeout?: number;
      maxBuffer?: number;
      encoding?: BufferEncoding;
      trusted?: boolean;
    },
  ): Promise<{ stdout: string; stderr: string; context: ToolExecutionContext }> {
    const context = await this.createExecutionContext({
      cwd: options.cwd,
      intent: options.intent,
      trusted: options.trusted,
    });
    const result = await this.execFromContext(capability, args, context, options);
    return { ...result, context };
  }

  async execFromContext(
    capability: ToolCapabilityId,
    args: string[],
    context: ToolExecutionContext,
    options: ExecuteFromContextOptions,
  ): Promise<{ stdout: string; stderr: string }> {
    const descriptor = this.requireFromContext(capability, context);
    const execOptions: ExecFileOptions = {
      cwd: options.cwd,
      env: { ...context.nativeEnv, ...options.env },
      timeout: options.timeout,
      maxBuffer: options.maxBuffer,
      encoding: options.encoding ?? "utf8",
      windowsHide: true,
    };
    const result = await execFileAsync(descriptor.executable, [...descriptor.argvPrefix, ...args], execOptions);
    return {
      stdout: String(result.stdout ?? ""),
      stderr: String(result.stderr ?? ""),
    };
  }

  async spawn(
    capability: ToolCapabilityId,
    args: string[],
    options: SpawnResolvedOptions,
  ): Promise<{ child: ChildProcess; context: ToolExecutionContext }> {
    const context = await this.createExecutionContext({
      cwd: options.cwd,
      intent: options.intent,
      trusted: options.trusted,
    });
    const child = this.spawnFromContext(capability, args, context, options);
    return { child, context };
  }

  spawnFromContext(
    capability: ToolCapabilityId,
    args: string[],
    context: ToolExecutionContext,
    options: Omit<SpawnResolvedOptions, "intent" | "trusted">,
  ): ChildProcess {
    const descriptor = this.requireFromContext(capability, context);
    return spawn(descriptor.executable, [...descriptor.argvPrefix, ...args], {
      cwd: options.cwd,
      env: { ...context.nativeEnv, ...options.env },
      shell: false,
      stdio: options.stdio ?? "pipe",
      windowsHide: options.windowsHide ?? true,
    });
  }
}

export const toolchainRuntime = new ToolchainRuntime();
