/** Stable Pi Desktop contract for the pinned Herdr v0.8.2 / protocol 20 adapter. */

export const HERDR_PROTOCOL_VERSION = 20 as const;
export const HERDR_SCHEMA_VERSION = 1 as const;
export const HERDR_MIN_VERSION = "0.8.2" as const;
export const HERDR_MAX_VERSION_EXCLUSIVE = "0.9.0" as const;

export const HERDR_AGENT_KINDS = [
  "pi",
  "claude",
  "codex",
  "gemini",
  "cursor",
  "devin",
  "agy",
  "cline",
  "omp",
  "mastracode",
  "opencode",
  "copilot",
  "kimi",
  "kiro",
  "droid",
  "amp",
  "grok",
  "hermes",
  "kilo",
  "qodercli",
  "qwen",
  "maki",
] as const;
export const HERDR_STARTABLE_AGENT_KINDS = [
  "pi",
  "claude",
  "codex",
  "gemini",
  "omp",
  "opencode",
  "copilot",
  "kimi",
  "droid",
  "grok",
  "qwen",
] as const;
export const HERDR_AGENT_PROMPT_MAX_BYTES = 256 * 1024;
export const HERDR_AGENT_WAIT_MAX_MS = 120_000;
export const HERDR_PANE_READ_MAX_BYTES = 64 * 1024;
export const HERDR_AGENT_ALIAS_PATTERN = "^[a-z][a-z0-9_-]{0,63}$" as const;

export type HerdrAgentKind = (typeof HERDR_AGENT_KINDS)[number];
export type HerdrStartableAgentKind = (typeof HERDR_STARTABLE_AGENT_KINDS)[number];
export type HerdrAgentCliSource =
  | "custom"
  | "path"
  | "official"
  | "npm"
  | "bun"
  | "uv"
  | "homebrew"
  | "macports"
  | "winget"
  | "system"
  | "version-manager";
export type HerdrAgentCliStatus = "detected" | "missing-locally" | "ambiguous";
export const HERDR_SAFE_AGENT_KEYS = [
  "enter",
  "esc",
  "tab",
  "backspace",
  "up",
  "down",
  "left",
  "right",
  "home",
  "end",
  "pageup",
  "pagedown",
  "delete",
  "ctrl+c",
] as const;
export type HerdrAgentKey = (typeof HERDR_SAFE_AGENT_KEYS)[number];
export type HerdrAgentKindDisplay = HerdrAgentKind | `unknown:${string}`;
export type HerdrAgentState = "blocked" | "working" | "done" | "idle" | "unknown";
export type HerdrIntegrationMode = "disabled" | "attach" | "managed";
export type HerdrBinarySource = "system" | "managed";
export type HerdrRuntimeStatus =
  | "disabled"
  | "probing"
  | "unavailable"
  | "starting"
  | "connecting"
  | "ready"
  | "degraded"
  | "reconnecting"
  | "incompatible"
  | "error";

export interface HerdrSettings {
  enabled: boolean;
  mode: "attach" | "managed";
  sessionName: string;
  autoConnect: boolean;
  releaseControlOnViewClose: boolean;
}

export const DEFAULT_HERDR_SETTINGS: HerdrSettings = {
  enabled: false,
  mode: "attach",
  sessionName: "default",
  autoConnect: true,
  releaseControlOnViewClose: true,
};

export type HerdrErrorCode =
  | "HERDR_DISABLED"
  | "HERDR_BINARY_NOT_FOUND"
  | "HERDR_BINARY_NOT_EXECUTABLE"
  | "HERDR_BINARY_INTEGRITY_FAILED"
  | "HERDR_VERSION_TOO_OLD"
  | "HERDR_VERSION_UNSUPPORTED"
  | "HERDR_PLATFORM_UNSUPPORTED"
  | "HERDR_PROTOCOL_UNSUPPORTED"
  | "HERDR_SCHEMA_UNSUPPORTED"
  | "HERDR_SERVER_CONFLICT"
  | "HERDR_SERVER_START_FAILED"
  | "HERDR_SERVER_RESTART_EXHAUSTED"
  | "HERDR_ENDPOINT_UNAVAILABLE"
  | "HERDR_ENDPOINT_UNSAFE"
  | "HERDR_REQUEST_TIMEOUT"
  | "HERDR_REQUEST_CANCELLED"
  | "HERDR_CONFIRMATION_REQUIRED"
  | "HERDR_PROTOCOL_LIMIT_EXCEEDED"
  | "HERDR_SCHEMA_INVALID"
  | "HERDR_AGENT_KIND_UNSUPPORTED"
  | "HERDR_AGENT_BLOCKED"
  | "HERDR_AGENT_NOT_READY"
  | "HERDR_AGENT_BINARY_MISSING"
  | "HERDR_PANE_NOT_FOUND"
  | "HERDR_SESSION_NOT_FOUND"
  | "HERDR_CWD_FORBIDDEN"
  | "HERDR_CONTROLLER_LOST"
  | "HERDR_TERMINAL_STREAM_INVALID"
  | "HERDR_INVALID_ARGUMENT"
  | "HERDR_TERMINAL_NOT_FOUND"
  | "HERDR_TERMINAL_NOT_CONTROLLER"
  | "HERDR_TERMINAL_BUSY"
  | "HERDR_TERMINAL_PROTOCOL"
  | "HERDR_INVALID_REQUEST"
  | "HERDR_INTERNAL";

export interface HerdrPublicError {
  code: HerdrErrorCode;
  message: string;
  retryable: boolean;
  action?: "retry" | "configure" | "upgrade" | "takeover" | "openLogs";
  detail?: {
    requiredVersion?: string;
    actualVersion?: string;
    requiredProtocol?: number;
    actualProtocol?: number;
  };
  upgradeRequired?: boolean;
}

/** Main-only policy. It is delivered to Agent Host and never exposed to Renderer. */
export interface HerdrRuntimeDescriptor {
  revision: number;
  /** Main-owned Agent Host generation. Added only while delivering policy to a Host. */
  hostGeneration?: number;
  /** True only for the immediate non-blocking startup descriptor. */
  probing?: boolean;
  enabled: boolean;
  mode: "attach" | "managed";
  sessionName: string;
  autoConnect: boolean;
  releaseControlOnViewClose: boolean;
  executable?: string;
  endpoint?: string;
  binarySource?: HerdrBinarySource;
  version?: string;
  protocol?: number;
  schemaVersion?: number;
  schemaSha256?: string;
  /** Path-free Main-owned Agent CLI discovery state. Absolute paths never cross this boundary. */
  agentClis?: HerdrAgentCliDiagnostic[];
  agentCliEnvironmentRevision?: number;
  agentCliRestartRequired?: boolean;
  error?: HerdrPublicError;
}

export interface HerdrRuntimeSnapshot {
  status: HerdrRuntimeStatus;
  mode: HerdrIntegrationMode;
  version?: string;
  protocol?: number;
  schemaVersion?: number;
  sessionName?: string;
  binarySource?: HerdrBinarySource;
  releaseControlOnViewClose: boolean;
  capabilities: {
    readOnly: boolean;
    agentControl: boolean;
    terminalObserve: boolean;
    terminalControl: boolean;
    ansiOnly: true;
    graphics: false;
  };
  error?: HerdrPublicError;
  sourceGeneration: number;
  descriptorRevision: number;
  revision: number;
  receivedAt: number;
}

export interface HerdrRuntimeConfigureRequest {
  settings: HerdrSettings;
}

export interface HerdrFleetSnapshot {
  sourceGeneration: number;
  revision: number;
  receivedAt: number;
  stale: boolean;
  focusedWorkspaceId?: string;
  focusedTabId?: string;
  focusedPaneId?: string;
  workspaces: HerdrWorkspace[];
  panes: HerdrPane[];
}

export interface HerdrWorkspace {
  id: string;
  name?: string;
  focused: boolean;
  rootPaneId?: string;
  tabs: HerdrTab[];
}

export interface HerdrTab {
  id: string;
  workspaceId: string;
  name?: string;
  focused: boolean;
  paneIds: string[];
}

export interface HerdrPane {
  id: string;
  terminalId: string;
  workspaceId: string;
  tabId: string;
  title?: string;
  cwd?: string;
  foregroundCwd?: string;
  focused: boolean;
  alive: boolean;
  revision: number;
  agent?: HerdrAgent;
}

export interface HerdrAgent {
  name?: string;
  kind: HerdrAgentKindDisplay;
  state: HerdrAgentState;
  session?: { kind: "id" | "path"; displayValue?: string };
  launchPending?: boolean;
  interactiveReady?: boolean;
  stateChangeSeq?: number;
}

export interface HerdrAgentExplanation {
  paneId: string;
  detected: boolean;
  agent?: {
    name?: string;
    kind: HerdrAgentKindDisplay;
    state: HerdrAgentState;
    interactiveReady: boolean;
    launchPending: boolean;
  };
  cli: {
    startSupported: boolean;
    available?: boolean;
    candidates?: HerdrAgentCliDiagnostic[];
  };
  detection: {
    available: boolean;
    evaluatedRuleCount?: number;
    matchedRule?: {
      id: string;
      state?: HerdrAgentState;
      region?: string;
    };
    fallbackReason?: string;
    manifestSource?: string;
    manifestVersion?: string;
    screenDetectionSkipped?: boolean;
    skipStateUpdate?: boolean;
    skippedUpdateReason?: string;
    visibleBlocker?: boolean;
    visibleIdle?: boolean;
    visibleWorking?: boolean;
  };
}

export interface HerdrPaneProcessSummary {
  paneId: string;
  shellDetected: boolean;
  foregroundProcessGroupDetected: boolean;
  processCount: number;
  truncated: boolean;
  foregroundProcesses: Array<{
    name: string;
    cwdMatchesPane: boolean;
  }>;
  agent?: {
    kind: HerdrAgentKindDisplay;
    state: HerdrAgentState;
    interactiveReady: boolean;
    launchPending: boolean;
  };
}

export interface HerdrPaneOutputWaitResult {
  paneId: string;
  matched: boolean;
  timedOut: boolean;
  revision?: number;
  matchedLine?: string;
}

export interface HerdrTerminalFrame {
  terminalId: string;
  seq: number;
  full: boolean;
  cols: number;
  rows: number;
  bytes: Uint8Array;
}

export type HerdrTerminalState =
  "opening" | "observing" | "controlling" | "controlled-elsewhere" | "controller-lost" | "closed" | "error";

export interface HerdrTerminalStatus {
  terminalId: string;
  paneId: string;
  state: HerdrTerminalState;
  mode: "observe" | "control";
  controller: boolean;
  ansiOnly: true;
  error?: HerdrPublicError;
  recovery?: "reopen-observe";
}

export interface HerdrAgentCliDiagnostic {
  kind: HerdrStartableAgentKind;
  available: boolean;
  status?: HerdrAgentCliStatus;
  source?: HerdrAgentCliSource;
  candidateCount?: number;
  restartRequired?: boolean;
  version?: string;
  errorCode?: HerdrErrorCode;
}

export interface HerdrDiagnostics {
  generatedAt: number;
  runtime: {
    status: HerdrRuntimeStatus;
    mode: HerdrIntegrationMode;
    source?: HerdrBinarySource;
    version?: string;
    protocol?: number;
    schemaVersion?: number;
    sessionName?: string;
  };
  fleet: {
    stale: boolean;
    workspaces: number;
    tabs: number;
    panes: number;
    agents: number;
  };
  terminal: {
    streams: number;
    controllers: number;
    frames: number;
    bytes: number;
    recentErrorCode?: HerdrErrorCode;
  };
  capabilities: HerdrRuntimeSnapshot["capabilities"];
  agentClis: HerdrAgentCliDiagnostic[];
  recentErrorCode?: HerdrErrorCode;
}

export function isHerdrAgentKind(value: unknown): value is HerdrAgentKind {
  return typeof value === "string" && (HERDR_AGENT_KINDS as readonly string[]).includes(value);
}

export function isHerdrStartableAgentKind(value: unknown): value is (typeof HERDR_STARTABLE_AGENT_KINDS)[number] {
  return typeof value === "string" && (HERDR_STARTABLE_AGENT_KINDS as readonly string[]).includes(value);
}

export function isHerdrAgentAlias(value: unknown): value is string {
  return typeof value === "string" && new RegExp(HERDR_AGENT_ALIAS_PATTERN).test(value);
}

export function isHerdrSessionName(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length >= 1 &&
    value.length <= 64 &&
    value !== "." &&
    value !== ".." &&
    !value.startsWith("-") &&
    /^[A-Za-z0-9._-]+$/.test(value)
  );
}

export function isHerdrSettings(value: unknown): value is HerdrSettings {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  const keys = new Set(["enabled", "mode", "sessionName", "autoConnect", "releaseControlOnViewClose"]);
  if (Object.keys(candidate).some((key) => !keys.has(key))) return false;
  return (
    typeof candidate.enabled === "boolean" &&
    (candidate.mode === "attach" || candidate.mode === "managed") &&
    isHerdrSessionName(candidate.sessionName) &&
    typeof candidate.autoConnect === "boolean" &&
    typeof candidate.releaseControlOnViewClose === "boolean"
  );
}

/** Migrates the former binary-source fields out of persisted Herdr settings. */
export function normalizeHerdrSettings(value: unknown): HerdrSettings {
  if (isHerdrSettings(value)) return structuredClone(value);
  if (!value || typeof value !== "object" || Array.isArray(value)) return structuredClone(DEFAULT_HERDR_SETTINGS);
  const candidate = value as Record<string, unknown>;
  const migrated = {
    enabled: candidate.enabled,
    mode: candidate.mode,
    sessionName: candidate.sessionName,
    autoConnect: candidate.autoConnect,
    releaseControlOnViewClose: candidate.releaseControlOnViewClose,
  };
  return isHerdrSettings(migrated) ? migrated : structuredClone(DEFAULT_HERDR_SETTINGS);
}
