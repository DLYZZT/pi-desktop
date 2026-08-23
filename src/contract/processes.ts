export const MANAGED_PROCESS_ACTIVE_STATES = [
  "created",
  "starting",
  "running",
  "ready",
  "stopping",
  "restarting",
] as const;

export type ManagedProcessActiveState = (typeof MANAGED_PROCESS_ACTIVE_STATES)[number];
export type ManagedProcessState = ManagedProcessActiveState | "exited" | "failed" | "killed" | "lost" | "reaped";

export type ManagedProcessKind = "server" | "watcher" | "task";
export type ManagedProcessReadiness = "not-requested" | "pending" | "ready" | "timed-out";
export type ManagedProcessLogStream = "stdout" | "stderr" | "system";
export type ManagedProcessStopMode = "graceful" | "force";
export type ManagedProcessStopSource = "agent" | "user" | "host" | "main";

export interface ManagedProcessExit {
  code: number | null;
  signal?: string;
  reason: "exit" | "error" | "stopped" | "reaped" | "host-failure";
  stoppedBy?: ManagedProcessStopSource;
  finishedAt: number;
}

export interface ManagedLoopbackEndpoint {
  id: string;
  url: string;
  source: "stdout" | "stderr" | "user";
  firstSeenAt: number;
  lastSeenAt: number;
  runId: string;
}

export interface ManagedProcessOutputSummary {
  earliestCursor: string;
  latestCursor: string;
  retainedBytes: number;
  droppedBytes: number;
  droppedRecords: number;
}

export interface ManagedProcessPublicInfo {
  processId: string;
  runId: string;
  generation: number;
  label: string;
  kind: ManagedProcessKind;
  state: ManagedProcessState;
  readiness: ManagedProcessReadiness;
  ownerSessionId: string;
  ownerLabel?: string;
  cwdDisplay: string;
  commandDisplay: string;
  createdAt: number;
  startedAt?: number;
  stoppedAt?: number;
  stdinOpen: boolean;
  endpoints: ManagedLoopbackEndpoint[];
  networkWarnings: string[];
  restartCount: number;
  lastOutput?: { stream: ManagedProcessLogStream; text: string; timestamp: number };
  exit?: ManagedProcessExit;
  output: ManagedProcessOutputSummary;
}

export interface ManagedProcessLogRecord {
  seq: number;
  timestamp: number;
  stream: ManagedProcessLogStream;
  text: string;
  runId: string;
}

export interface ManagedProcessLogGap {
  droppedBytes: number;
  droppedRecords: number;
}

export interface ManagedProcessLogWindow {
  processId: string;
  runId: string;
  fromCursor: string;
  nextCursor: string;
  earliestCursor: string;
  records: ManagedProcessLogRecord[];
  truncated: boolean;
  timedOut?: boolean;
  matched?: string;
  gap?: ManagedProcessLogGap;
  state: ManagedProcessState;
  readiness: ManagedProcessReadiness;
  endpoints: ManagedLoopbackEndpoint[];
  exit?: ManagedProcessExit;
}

export type ManagedProcessWaitFor =
  | { type: "none" }
  | { type: "output"; contains: string; timeoutMs?: number }
  | { type: "loopback-url"; timeoutMs?: number };

export interface ManagedProcessStartParams {
  command: string;
  cwd?: string;
  label?: string;
  kind?: ManagedProcessKind;
  waitFor?: ManagedProcessWaitFor;
  activateUi?: boolean;
}

export interface ManagedProcessStartResult {
  process: ManagedProcessPublicInfo;
  runId: string;
  state: "starting" | "running" | "ready" | "exited" | "failed";
  output: ManagedProcessLogWindow;
  readiness: {
    state: ManagedProcessReadiness;
    matched?: string;
  };
  endpoints: ManagedLoopbackEndpoint[];
}

export interface ManagedProcessReadParams {
  processId: string;
  runId?: string;
  cursor?: string;
  maxBytes?: number;
  streams?: ManagedProcessLogStream[];
}

export interface ManagedProcessWaitParams extends ManagedProcessReadParams {
  timeoutMs?: number;
  contains?: string;
}

export interface ManagedProcessWriteParams {
  processId: string;
  runId: string;
  text: string;
  appendNewline?: boolean;
  close?: boolean;
}

export interface ManagedProcessChangedEvent {
  revision: number;
  processId: string;
  runId: string;
  reason: "created" | "state" | "readiness" | "exit" | "dismissed";
  activateUi?: boolean;
}

export interface ManagedProcessOutputEvent {
  revision: number;
  processId: string;
  runId: string;
  latestCursor: string;
}

export interface PosixManagedProcessReaperRecord {
  version: 2;
  platform: "posix";
  processId: string;
  runId: string;
  hostInstanceId: string;
  pid: number;
  pgid: number;
  startFingerprint: string;
  nonce: string;
  createdAt: number;
}

export interface WindowsManagedProcessReaperRecord {
  version: 2;
  platform: "win32";
  processId: string;
  runId: string;
  hostInstanceId: string;
  helperPid: number;
  helperStartFingerprint: string;
  jobName: string;
  helperBuildId: string;
  nonce: string;
  createdAt: number;
}

export type ManagedProcessReaperRecord = PosixManagedProcessReaperRecord | WindowsManagedProcessReaperRecord;

export type ManagedProcessCapabilityErrorCode =
  | "PLATFORM_UNSUPPORTED"
  | "ARCH_UNSUPPORTED"
  | "OWNER_IDENTITY_UNAVAILABLE"
  | "HELPER_MISSING"
  | "HELPER_INTEGRITY"
  | "REAPER_UNHEALTHY";

export interface ManagedProcessCapability {
  platform: NodeJS.Platform;
  arch: NodeJS.Architecture;
  supported: boolean;
  ready: boolean;
  backend: "posix-group" | "windows-job" | "none";
  helperBuildId?: string;
  helperProvenance?: "windows-native-dev" | "release-authoritative";
  errorCode?: ManagedProcessCapabilityErrorCode;
}

export interface ManagedProcessOwnerIdentityV1 {
  version: 1;
  mainPid: number;
  mainStartFingerprint: string;
  mainImagePath: string;
  hostInstanceId: string;
}

export const PROCESS_ERROR_CODES = [
  "PROCESS_FEATURE_DISABLED",
  "PROCESS_PLATFORM_UNSUPPORTED",
  "PROCESS_PROJECT_UNTRUSTED",
  "PROCESS_SHELL_UNAVAILABLE",
  "PROCESS_CWD_DENIED",
  "PROCESS_COMMAND_BLOCKED",
  "PROCESS_CONFIRMATION_REQUIRED",
  "PROCESS_LIMIT_REACHED",
  "PROCESS_CONTAINMENT_UNAVAILABLE",
  "PROCESS_NOT_FOUND",
  "PROCESS_STALE_RUN",
  "PROCESS_NOT_RUNNING",
  "PROCESS_STDIN_CLOSED",
  "PROCESS_OUTPUT_GAP",
  "PROCESS_STOP_TIMEOUT",
  "PROCESS_TREE_REAP_FAILED",
  "PROCESS_USER_STOPPED",
  "PROCESS_HOST_RESTARTED",
  "PROCESS_EXPORT_FAILED",
] as const;

export type ManagedProcessErrorCode = (typeof PROCESS_ERROR_CODES)[number];

export function isManagedProcessActiveState(state: ManagedProcessState): state is ManagedProcessActiveState {
  return (MANAGED_PROCESS_ACTIVE_STATES as readonly string[]).includes(state);
}
