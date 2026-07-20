/**
 * Plugin package management for the desktop Agent Host.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "fs";
import { basename, dirname, extname, join, relative } from "path";
import {
  DefaultPackageManager,
  getAgentDir,
  SettingsManager,
  type PackageSource,
  type ResolvedPaths,
  type ResolvedResource,
} from "@earendil-works/pi-coding-agent";
import type {
  PluginDiagnostic,
  PluginPackageInfo,
  PluginResourceCounts,
  PluginResourceInfo,
  PluginResourceKind,
  PluginScope,
  PluginsResponse,
} from "../shared/api-types";
import { RpcError } from "../contract/types";
import { toolchainRuntime } from "./toolchain-runtime";
import { runPluginWorker } from "./plugin-worker-client";
import type { PluginActionBody } from "./plugin-worker-protocol";

function emptyCounts(): PluginResourceCounts {
  return { extensions: 0, skills: 0, prompts: 0, themes: 0 };
}

function toPluginScope(scope: string): PluginScope {
  return scope === "project" ? "project" : "global";
}

function keyFor(source: string, scope: PluginScope): string {
  return `${scope}\0${source}`;
}

function disabledBackupPath(): string {
  return join(getAgentDir(), "pi-desktop-plugin-filters.json");
}

function readDisabledBackups(): Record<string, PackageSource> {
  try {
    return JSON.parse(readFileSync(disabledBackupPath(), "utf8")) as Record<string, PackageSource>;
  } catch {
    return {};
  }
}

function writeDisabledBackups(backups: Record<string, PackageSource>): void {
  const filePath = disabledBackupPath();
  const tmp = `${filePath}.${process.pid}.tmp`;
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(tmp, JSON.stringify(backups, null, 2), "utf8");
  try {
    renameSync(tmp, filePath);
  } catch (error) {
    try {
      unlinkSync(tmp);
    } catch {
      /* ignore cleanup failure */
    }
    throw error;
  }
}

function clearDisabledBackup(source: string, scope: PluginScope): void {
  const backups = readDisabledBackups();
  const key = keyFor(source, scope);
  if (!(key in backups)) return;
  delete backups[key];
  writeDisabledBackups(backups);
}

function getPackageSource(entry: PackageSource): string {
  return typeof entry === "string" ? entry : entry.source;
}

function withEphemeralNpmCommand(settingsManager: SettingsManager, npmCommand?: string[]): SettingsManager {
  const command = npmCommand?.length ? [...npmCommand] : undefined;
  return new Proxy(settingsManager, {
    get(target, property) {
      if (property === "getNpmCommand") return () => (command ? [...command] : undefined);
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

function configuredSources(settingsManager: SettingsManager): string[] {
  return [
    ...(settingsManager.getGlobalSettings().packages ?? []),
    ...(settingsManager.getProjectSettings().packages ?? []),
  ].map(getPackageSource);
}

function isNpmSource(source: string): boolean {
  return source.startsWith("npm:");
}

function isGitSource(source: string): boolean {
  return source.startsWith("git:") || /^(?:https?|ssh|git):\/\//i.test(source) || /^[^@\s]+@[^:\s]+:.+/.test(source);
}

function isDisabledPackage(entry: PackageSource): boolean {
  if (typeof entry === "string") return false;
  return (
    Array.isArray(entry.extensions) &&
    entry.extensions.length === 0 &&
    Array.isArray(entry.skills) &&
    entry.skills.length === 0 &&
    Array.isArray(entry.prompts) &&
    entry.prompts.length === 0 &&
    Array.isArray(entry.themes) &&
    entry.themes.length === 0
  );
}

function getDisabledPackages(settingsManager: SettingsManager): Map<string, boolean> {
  const disabled = new Map<string, boolean>();
  for (const entry of settingsManager.getGlobalSettings().packages ?? []) {
    disabled.set(keyFor(getPackageSource(entry), "global"), isDisabledPackage(entry));
  }
  for (const entry of settingsManager.getProjectSettings().packages ?? []) {
    disabled.set(keyFor(getPackageSource(entry), "project"), isDisabledPackage(entry));
  }
  return disabled;
}

function setPackageDisabled(
  settingsManager: SettingsManager,
  source: string,
  scope: PluginScope,
  disabled: boolean,
): boolean {
  const current =
    scope === "project"
      ? (settingsManager.getProjectSettings().packages ?? [])
      : (settingsManager.getGlobalSettings().packages ?? []);
  let changed = false;
  const backups = readDisabledBackups();
  const backupKey = keyFor(source, scope);
  const next = current.map((entry): PackageSource => {
    if (getPackageSource(entry) !== source) return entry;
    changed = true;
    if (disabled) {
      backups[backupKey] = entry;
      return {
        ...(typeof entry === "string" ? { source: entry } : entry),
        extensions: [],
        skills: [],
        prompts: [],
        themes: [],
      };
    }
    const restored = backups[backupKey] ?? getPackageSource(entry);
    delete backups[backupKey];
    return restored;
  });
  if (!changed) return false;
  writeDisabledBackups(backups);
  if (scope === "project") settingsManager.setProjectPackages(next);
  else settingsManager.setPackages(next);
  return true;
}

function addCount(counts: PluginResourceCounts, kind: keyof PluginResourceCounts): void {
  counts[kind] += 1;
}

function getResourceName(path: string, kind: PluginResourceKind): string {
  const file = basename(path);
  const ext = extname(file);
  if (kind === "skill" && file.toLowerCase() === "skill.md") return basename(dirname(path));
  if ((kind === "extension" || kind === "theme" || kind === "prompt") && ext) {
    if (kind === "extension" && /^index\.(ts|js)$/.test(file)) return basename(dirname(path));
    return file.slice(0, -ext.length);
  }
  return file;
}

function getRelativePath(resource: ResolvedResource): string {
  const baseDir = resource.metadata.baseDir;
  if (!baseDir) return resource.path;
  const rel = relative(baseDir, resource.path);
  return rel && !rel.startsWith("..") ? rel : resource.path;
}

function getConfiguredVersion(source: string): string | undefined {
  const npmSpec = source.startsWith("npm:") ? source.slice(4) : undefined;
  if (npmSpec) {
    const lastAt = npmSpec.lastIndexOf("@");
    const packageNameEnd = npmSpec.startsWith("@") ? npmSpec.indexOf("/", 1) : 0;
    if (lastAt > packageNameEnd) return npmSpec.slice(lastAt + 1) || undefined;
    return undefined;
  }
  if (source.startsWith("git:") || /^[a-z]+:\/\//.test(source)) {
    const lastAt = source.lastIndexOf("@");
    const lastSlash = source.lastIndexOf("/");
    const lastColon = source.lastIndexOf(":");
    if (lastAt > Math.max(lastSlash, lastColon)) return source.slice(lastAt + 1) || undefined;
  }
  return undefined;
}

function readPackageMetadata(installedPath?: string): { packageName?: string; version?: string } {
  if (!installedPath) return {};
  try {
    const stats = statSync(installedPath);
    const packageJsonPath = stats.isDirectory()
      ? join(installedPath, "package.json")
      : join(dirname(installedPath), "package.json");
    if (!existsSync(packageJsonPath)) return {};
    const parsed = JSON.parse(readFileSync(packageJsonPath, "utf8")) as {
      name?: unknown;
      version?: unknown;
    };
    return {
      packageName: typeof parsed.name === "string" ? parsed.name : undefined,
      version: typeof parsed.version === "string" ? parsed.version : undefined,
    };
  } catch {
    return {};
  }
}

function collectResource(
  resource: ResolvedResource,
  kind: keyof PluginResourceCounts,
  countsByPackage: Map<string, PluginResourceCounts>,
  resourcesByPackage: Map<string, PluginResourceInfo[]>,
  totals: PluginResourceCounts,
): void {
  if (!resource.enabled || resource.metadata.origin !== "package") return;
  const source = resource.metadata.source;
  const scope = toPluginScope(resource.metadata.scope);
  const key = keyFor(source, scope);
  const counts = countsByPackage.get(key) ?? emptyCounts();
  addCount(counts, kind);
  addCount(totals, kind);
  countsByPackage.set(key, counts);
  const resources = resourcesByPackage.get(key) ?? [];
  const resourceKind =
    kind === "extensions" ? "extension" : kind === "skills" ? "skill" : kind === "prompts" ? "prompt" : "theme";
  resources.push({
    kind: resourceKind,
    name: getResourceName(resource.path, resourceKind),
    path: resource.path,
    relativePath: getRelativePath(resource),
  });
  resourcesByPackage.set(key, resources);
}

function collectResources(paths: ResolvedPaths) {
  const countsByPackage = new Map<string, PluginResourceCounts>();
  const resourcesByPackage = new Map<string, PluginResourceInfo[]>();
  const totals = emptyCounts();
  for (const r of paths.extensions) collectResource(r, "extensions", countsByPackage, resourcesByPackage, totals);
  for (const r of paths.skills) collectResource(r, "skills", countsByPackage, resourcesByPackage, totals);
  for (const r of paths.prompts) collectResource(r, "prompts", countsByPackage, resourcesByPackage, totals);
  for (const r of paths.themes) collectResource(r, "themes", countsByPackage, resourcesByPackage, totals);
  return { countsByPackage, resourcesByPackage, totals };
}

export async function readPlugins(cwd: string, npmCommand?: string[]): Promise<PluginsResponse> {
  const rawSettingsManager = SettingsManager.create(cwd, getAgentDir());
  const settingsManager = withEphemeralNpmCommand(rawSettingsManager, npmCommand);
  const packageManager = new DefaultPackageManager({
    cwd,
    agentDir: getAgentDir(),
    settingsManager,
  });

  const diagnostics: PluginDiagnostic[] = [];
  let countsByPackage = new Map<string, PluginResourceCounts>();
  let resourcesByPackage = new Map<string, PluginResourceInfo[]>();
  let totals = emptyCounts();
  const disabledByPackage = getDisabledPackages(settingsManager);

  try {
    const resolved = await packageManager.resolve(async (source) => {
      diagnostics.push({
        type: "warning",
        source,
        message: "Package is configured but not installed yet.",
      });
      return "skip";
    });
    ({ countsByPackage, resourcesByPackage, totals } = collectResources(resolved));
  } catch (error) {
    diagnostics.push({
      type: "error",
      message: error instanceof Error ? error.message : String(error),
    });
  }

  const packages = packageManager.listConfiguredPackages().map((pkg) => {
    const scope = toPluginScope(pkg.scope);
    const key = keyFor(pkg.source, scope);
    const disabled = disabledByPackage.get(key) ?? false;
    const counts = countsByPackage.get(key) ?? emptyCounts();
    const resources = resourcesByPackage.get(key) ?? [];
    const resourceCount = counts.extensions + counts.skills + counts.prompts + counts.themes;
    const packageMetadata = readPackageMetadata(pkg.installedPath);
    if (!pkg.installedPath) {
      diagnostics.push({
        type: "warning",
        source: pkg.source,
        message: "Configured package path was not found.",
      });
    }
    return {
      source: pkg.source,
      scope,
      filtered: pkg.filtered,
      disabled,
      installedPath: pkg.installedPath,
      packageName: packageMetadata.packageName,
      version: packageMetadata.version,
      configuredVersion: getConfiguredVersion(pkg.source),
      counts,
      resources,
      status: disabled ? "disabled" : resourceCount > 0 ? "loaded" : pkg.installedPath ? "installed" : "missing",
    } satisfies PluginPackageInfo;
  });

  return { packages, totals, diagnostics };
}

export async function applyPluginAction(body: PluginActionBody): Promise<PluginsResponse> {
  validatePluginActionBody(body);
  if (body.action === "disable" || body.action === "enable") {
    return applyPluginActionInProcess(body);
  }

  const context = await toolchainRuntime.createExecutionContext({ cwd: body.cwd, intent: "plugin-install" });
  const settingsManager = SettingsManager.create(body.cwd, getAgentDir());
  const sources = body.source ? [body.source] : configuredSources(settingsManager);
  const needsNpm = (body.action === "install" || body.action === "update") && sources.some(isNpmSource);
  const needsGit = (body.action === "install" || body.action === "update") && sources.some(isGitSource);
  if (needsNpm) toolchainRuntime.requireFromContext("js.npm", context);
  if (needsGit) toolchainRuntime.requireFromContext("vcs.git", context);
  const npm = context.commands["js.npm"];
  const npmCommand = npm ? [npm.executable, ...npm.argvPrefix] : undefined;
  return runPluginWorker({ body, npmCommand }, context);
}

function validatePluginActionBody(body: PluginActionBody): void {
  if (!body.cwd) throw new RpcError({ code: "BAD_REQUEST", message: "cwd required" });
  if (!body.action) throw new RpcError({ code: "BAD_REQUEST", message: "action required" });
}

export async function applyPluginActionInProcess(
  body: PluginActionBody,
  npmCommand?: string[],
): Promise<PluginsResponse> {
  validatePluginActionBody(body);
  const rawSettingsManager = SettingsManager.create(body.cwd, getAgentDir());
  const settingsManager = withEphemeralNpmCommand(rawSettingsManager, npmCommand);
  const packageManager = new DefaultPackageManager({
    cwd: body.cwd,
    agentDir: getAgentDir(),
    settingsManager,
  });
  const source = body.source?.trim();
  const local = (body.scope === "project" ? "project" : "global") === "project";

  if (body.action === "install") {
    if (!source) throw new RpcError({ code: "BAD_REQUEST", message: "source required" });
    await packageManager.installAndPersist(source, { local });
  } else if (body.action === "remove") {
    if (!source) throw new RpcError({ code: "BAD_REQUEST", message: "source required" });
    await packageManager.removeAndPersist(source, { local });
    clearDisabledBackup(source, body.scope === "project" ? "project" : "global");
  } else if (body.action === "update") {
    await packageManager.update(source);
  } else if (body.action === "disable") {
    if (!source) throw new RpcError({ code: "BAD_REQUEST", message: "source required" });
    setPackageDisabled(settingsManager, source, body.scope === "project" ? "project" : "global", true);
    await settingsManager.flush();
  } else if (body.action === "enable") {
    if (!source) throw new RpcError({ code: "BAD_REQUEST", message: "source required" });
    setPackageDisabled(settingsManager, source, body.scope === "project" ? "project" : "global", false);
    await settingsManager.flush();
  } else {
    throw new RpcError({ code: "BAD_REQUEST", message: `Unsupported action: ${body.action}` });
  }

  return readPlugins(body.cwd, npmCommand);
}
