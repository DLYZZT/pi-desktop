export const TOOL_CAPABILITY_IDS = [
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
] as const;

export type ToolCapabilityId = (typeof TOOL_CAPABILITY_IDS)[number];

export const MANAGED_COMPONENT_IDS = [
  "portable-git",
  "node-lts",
  "cpython",
  "uv",
  "ripgrep",
  "fd",
  "jq",
  "bun",
] as const;

export type ManagedComponentId = (typeof MANAGED_COMPONENT_IDS)[number];

export const TOOLCHAIN_PROFILE_IDS = [
  "javascript-essentials",
  "python-essentials",
  "windows-shell-essentials",
  "cli-essentials",
] as const;

export type ToolchainProfileId = (typeof TOOLCHAIN_PROFILE_IDS)[number];

export const TOOLCHAIN_CACHE_IDS = ["npm", "uv", "bun", "downloads"] as const;

export type ToolchainCacheId = (typeof TOOLCHAIN_CACHE_IDS)[number];

export const TOOL_PROVIDERS = ["project", "custom", "system", "bundled", "managed", "legacy-upstream-managed"] as const;

export type ToolProvider = (typeof TOOL_PROVIDERS)[number];

export const TOOL_PREFERENCES = ["auto", "system", "bundled", "managed", "custom"] as const;

export type ToolPreference = (typeof TOOL_PREFERENCES)[number];

export const TOOL_HEALTH_VALUES = [
  "healthy",
  "missing",
  "incomplete",
  "unsupported",
  "unverified",
  "broken",
  "modified",
  "blocked-by-trust",
] as const;

export type ToolHealth = (typeof TOOL_HEALTH_VALUES)[number];

export const TOOLCHAIN_ERROR_CODES = [
  "TOOLCHAIN_CAPABILITY_REQUIRED",
  "TOOLCHAIN_NODE_REQUIRED",
  "TOOLCHAIN_PYTHON_REQUIRED",
  "TOOLCHAIN_GIT_REQUIRED",
  "TOOLCHAIN_BASH_REQUIRED",
  "TOOLCHAIN_UV_REQUIRED",
  "TOOLCHAIN_INCOMPLETE",
  "TOOLCHAIN_UNSUPPORTED",
  "TOOLCHAIN_UNVERIFIED",
  "TOOLCHAIN_BROKEN",
  "TOOLCHAIN_MODIFIED",
  "TOOLCHAIN_PROJECT_UNTRUSTED",
  "TOOLCHAIN_DOWNLOAD_OFFLINE",
  "TOOLCHAIN_DOWNLOAD_REJECTED",
  "TOOLCHAIN_INTEGRITY_FAILED",
  "TOOLCHAIN_EXTRACTION_FAILED",
  "TOOLCHAIN_INSTALL_BUSY",
  "TOOLCHAIN_PERMISSION_DENIED",
  "TOOLCHAIN_INVALID_SELECTION",
  "TOOLCHAIN_INVALID_CATALOG",
  "TOOLCHAIN_CANCELLED",
  "TOOLCHAIN_INTERNAL",
] as const;

export type ToolchainErrorCode = (typeof TOOLCHAIN_ERROR_CODES)[number];

export interface ToolCandidate {
  id: string;
  capability: ToolCapabilityId;
  provider: ToolProvider;
  discovery: string;
  executable: string;
  argvPrefix?: string[];
  binDir: string;
  version?: string;
  componentId?: ManagedComponentId;
  componentRoot?: string;
  health: ToolHealth;
  reasonCode?: ToolchainErrorCode;
  rank: number;
  pathOrder?: number;
  discoveredAt?: string;
}

export interface CommandDescriptor {
  capability: ToolCapabilityId;
  provider: ToolProvider;
  executable: string;
  argvPrefix: string[];
  binDir: string;
  /** Additional context-only PATH entries, ordered before binDir. */
  pathEntries?: string[];
  /** Additional PATH entries used only when spawning the selected shell. */
  shellPathEntries?: string[];
  componentId?: ManagedComponentId;
  componentRoot?: string;
  version?: string;
  cwdSemantics: "native" | "msys" | "posix";
  envPatch: Record<string, string>;
  /** Applied only to the Agent shell process, never to native Git/npm/Python children. */
  shellEnvPatch?: Record<string, string>;
}

export interface ProjectToolRequirements {
  cwd: string;
  trusted: boolean;
  nodeRange?: string;
  packageManager?: "npm" | "pnpm" | "yarn" | "bun";
  pythonRequest?: string;
  pythonEnvironment?: string;
  markers: string[];
}

export interface PublicToolCandidate {
  id: string;
  capability: ToolCapabilityId;
  provider: ToolProvider;
  version?: string;
  pathLabel: string;
  health: ToolHealth;
  reasonCode?: ToolchainErrorCode;
}

export interface PublicCapabilityState {
  capability: ToolCapabilityId;
  preference: ToolPreference;
  provider?: ToolProvider;
  version?: string;
  pathLabel?: string;
  health: ToolHealth;
  reasonCode?: ToolchainErrorCode;
  candidates: PublicToolCandidate[];
}

export interface PublicManagedComponentState {
  componentId: ManagedComponentId;
  installed: boolean;
  activeVersion?: string;
  availableVersion?: string;
  platformArch?: string;
  downloadBytes?: number;
  /** Catalog estimate for the active version, when the upstream publishes one. */
  installedBytes?: number;
  /** Bounded, no-symlink-following measurement of all installed versions. */
  diskBytes?: number;
  sourceName?: string;
  licenseName?: string;
  licenseUrl?: string;
  health: ToolHealth;
  canInstall: boolean;
  canRepair: boolean;
  canRemove: boolean;
}

export interface PublicToolchainCacheState {
  cacheId: ToolchainCacheId;
  diskBytes?: number;
  canClear: boolean;
}

export type ToolchainInstallPhase =
  | "idle"
  | "queued"
  | "downloading"
  | "verifying"
  | "extracting"
  | "probing"
  | "activating"
  | "ready"
  | "error"
  | "cancelled";

export interface PublicToolchainOperation {
  operationId: string;
  componentId: ManagedComponentId;
  phase: ToolchainInstallPhase;
  downloadedBytes?: number;
  totalBytes?: number;
  error?: {
    code: ToolchainErrorCode;
    message: string;
  };
}

export interface PublicToolchainState {
  schemaVersion: 1;
  revision: number;
  platform: NodeJS.Platform;
  arch: string;
  coreReady: boolean;
  stateReadOnly?: boolean;
  capabilities: Partial<Record<ToolCapabilityId, PublicCapabilityState>>;
  components: Partial<Record<ManagedComponentId, PublicManagedComponentState>>;
  caches?: Partial<Record<ToolchainCacheId, PublicToolchainCacheState>>;
  operations: PublicToolchainOperation[];
  /** Path-free, project-aware requirement/provider hints for Developer Tools. */
  projectSummary?: string[];
  lastScanAt?: string;
  lastErrorCode?: ToolchainErrorCode;
}

export interface ToolchainSnapshot {
  revision: number;
  generatedAt: string;
  platform: NodeJS.Platform;
  arch: string;
  candidates: ToolCandidate[];
  defaults: Partial<Record<ToolCapabilityId, CommandDescriptor>>;
  publicState: PublicToolchainState;
}

export interface ToolchainResolution {
  id: string;
  inventoryRevision: number;
  workspaceKey: string;
  requirementsHash: string;
  commands: Partial<Record<ToolCapabilityId, CommandDescriptor>>;
  summary: string[];
}

export const EXECUTION_INTENTS = [
  "agent-shell",
  "skill-install",
  "plugin-install",
  "git-operation",
  "python-script",
  "project-command",
] as const;

export type ExecutionIntent = (typeof EXECUTION_INTENTS)[number];

export interface ExecutionContextRequest {
  cwd: string;
  intent: ExecutionIntent;
  /** Main accepts this only from the app-owned Host, never from Renderer IPC. */
  trusted?: boolean;
}

export interface ToolExecutionContext {
  inventoryRevision: number;
  resolutionId: string;
  nativeEnv: NodeJS.ProcessEnv;
  shellEnv: NodeJS.ProcessEnv;
  commands: Partial<Record<ToolCapabilityId, CommandDescriptor>>;
  summary: string[];
}

export type ToolchainActionRequest =
  | { action: "install-profile"; profileId: ToolchainProfileId }
  | { action: "install-component"; componentId: ManagedComponentId }
  | { action: "repair-component"; componentId: ManagedComponentId }
  | { action: "cancel-component-install"; componentId: ManagedComponentId }
  | { action: "remove-component"; componentId: ManagedComponentId }
  | {
      action: "set-preference";
      capability: ToolCapabilityId;
      preference: ToolPreference;
    }
  | { action: "choose-custom-tool"; capability: ToolCapabilityId }
  | { action: "clear-cache"; cacheId: ToolchainCacheId }
  | { action: "rescan" };

export function isToolCapabilityId(value: unknown): value is ToolCapabilityId {
  return typeof value === "string" && (TOOL_CAPABILITY_IDS as readonly string[]).includes(value);
}

export function isManagedComponentId(value: unknown): value is ManagedComponentId {
  return typeof value === "string" && (MANAGED_COMPONENT_IDS as readonly string[]).includes(value);
}

export function isToolchainProfileId(value: unknown): value is ToolchainProfileId {
  return typeof value === "string" && (TOOLCHAIN_PROFILE_IDS as readonly string[]).includes(value);
}

export function isToolPreference(value: unknown): value is ToolPreference {
  return typeof value === "string" && (TOOL_PREFERENCES as readonly string[]).includes(value);
}

export function isToolchainCacheId(value: unknown): value is ToolchainCacheId {
  return typeof value === "string" && (TOOLCHAIN_CACHE_IDS as readonly string[]).includes(value);
}

export function isToolchainActionRequest(value: unknown): value is ToolchainActionRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const request = value as Record<string, unknown>;
  const keys = Object.keys(request).sort();
  const hasExactKeys = (...expected: string[]) => keys.join("\0") === expected.sort().join("\0");
  switch (request.action) {
    case "install-profile":
      return hasExactKeys("action", "profileId") && isToolchainProfileId(request.profileId);
    case "install-component":
    case "repair-component":
    case "cancel-component-install":
    case "remove-component":
      return hasExactKeys("action", "componentId") && isManagedComponentId(request.componentId);
    case "set-preference":
      return (
        hasExactKeys("action", "capability", "preference") &&
        isToolCapabilityId(request.capability) &&
        isToolPreference(request.preference)
      );
    case "choose-custom-tool":
      return hasExactKeys("action", "capability") && isToolCapabilityId(request.capability);
    case "clear-cache":
      return hasExactKeys("action", "cacheId") && isToolchainCacheId(request.cacheId);
    case "rescan":
      return hasExactKeys("action");
    default:
      return false;
  }
}

export function isExecutionIntent(value: unknown): value is ExecutionIntent {
  return typeof value === "string" && (EXECUTION_INTENTS as readonly string[]).includes(value);
}
