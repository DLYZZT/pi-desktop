import path from "node:path";
import { realpath } from "node:fs/promises";
import { createHash } from "node:crypto";
import type { ManagedLoopbackEndpoint, ManagedProcessLogStream } from "../contract/processes.ts";

export const MANAGED_PROCESS_LIMITS = {
  commandBytes: 32 * 1024,
  labelCodePoints: 80,
  lineBytes: 16 * 1024,
  processBytes: 2 * 1024 * 1024,
  processRecords: 10_000,
  globalBytes: 16 * 1024 * 1024,
  agentReadDefaultBytes: 32 * 1024,
  agentReadMaxBytes: 128 * 1024,
  rendererReadDefaultBytes: 64 * 1024,
  rendererReadMaxBytes: 256 * 1024,
  stdinBytes: 64 * 1024,
  sessionActive: 4,
  globalActive: 8,
  exitedRecords: 64,
  exitedRetentionMs: 15 * 60_000,
  waitDefaultMs: 10_000,
  waitMaxMs: 30_000,
  startWaitDefaultMs: 1_000,
  startWaitMaxMs: 10_000,
  endpointCount: 8,
} as const;

const BLOCKED_COMMANDS: Array<{ pattern: RegExp; reason: string }> = [
  { pattern: /(?:^|[;&|()\s])nohup(?:\s|$)/i, reason: "nohup detaches the process from the manager" },
  { pattern: /(?:^|[;&|()\s])disown(?:\s|$)/i, reason: "disown detaches the process from the manager" },
  { pattern: /(?:^|[;&|()\s])setsid(?:\s|$)/i, reason: "setsid creates an unmanaged process group" },
  { pattern: /(?:^|[;&|()\s])daemonize(?:\s|$)/i, reason: "daemonize escapes managed lifecycle" },
  { pattern: /(?:^|[;&|()\s])systemd-run(?:\s|$)/i, reason: "systemd-run creates an external service" },
  { pattern: /(?:^|[;&|()\s])launchctl\s+submit(?:\s|$)/i, reason: "launchctl creates an external service" },
  {
    pattern: /(?:^|[;&|()\s])open\s+-a\s+(?:Terminal|iTerm)(?:\s|$)/i,
    reason: "external terminal processes are unmanaged",
  },
  { pattern: /(?:^|[;&|()\s])start\s+\/b(?:\s|$)/i, reason: "start /b is not supported by managed processes" },
  { pattern: /\bStart-Process\b/i, reason: "PowerShell Start-Process is not supported by managed processes" },
  { pattern: /(?:^|[^&])&\s*(?:$|[\r\n])/, reason: "background shell control is not allowed" },
  { pattern: /(?:^|[^&>])&(?![&>])(?=\s|$)/, reason: "background shell control is not allowed" },
  { pattern: /&!\s*(?:$|[\r\n])/, reason: "background shell control is not allowed" },
];

const LAN_BIND_PATTERNS = [
  /(?:--host(?:=|\s+)|\bHOST=)(?:0\.0\.0\.0|::)(?::\d+)?(?:\s|$)/i,
  /(?:--listen(?:=|\s+)|\bBIND=)(?:0\.0\.0\.0|::)(?::\d+)?(?:\s|$)/i,
];

const ANSI_OSC = /\u001b\](?:[^\u0007\u001b]|\u001b(?!\\))*(?:\u0007|\u001b\\)/g;
const ANSI_CSI = /\u001b\[[0-?]*[ -/]*[@-~]/g;
const ANSI_SINGLE = /\u001b[@-_]/g;
const URL_CREDENTIALS = /([a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+:[^\s/@]+@/gi;
const AUTHORIZATION_HEADER = /\b(authorization)(\s*[:=]\s*)(?:(?:bearer|basic)\s+)?[^\s,;]+/gi;
const SECRET_CLI_ARGUMENT =
  /(--(?:api[_-]?key|access[_-]?token|refresh[_-]?token|token|password|secret|npm[_-]?token|node[_-]?auth[_-]?token)(?:=|\s+))([^\s]+)/gi;
const COMMON_SECRET_TOKEN =
  /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{20,}|npm_[A-Za-z0-9]{20,}|xox[baprs]-[A-Za-z0-9-]{20,}|eyJ[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{8,})\b/g;
const SECRET_ASSIGNMENT =
  /\b(authorization|cookie|set-cookie|api[_-]?key|access[_-]?token|refresh[_-]?token|token|password|secret|npm_token|node_auth_token)(\s*[:=]\s*)([^\s,;]+)/gi;
const PI_NONCE = /\b(PI_DESKTOP_[A-Z0-9_]*(?:NONCE|TOKEN|SECRET))=([^\s]+)/g;

export class ManagedProcessPolicyError extends Error {
  readonly code: "PROCESS_CWD_DENIED" | "PROCESS_COMMAND_BLOCKED" | "PROCESS_CONFIRMATION_REQUIRED";

  constructor(
    code: "PROCESS_CWD_DENIED" | "PROCESS_COMMAND_BLOCKED" | "PROCESS_CONFIRMATION_REQUIRED",
    message: string,
  ) {
    super(message);
    this.name = "ManagedProcessPolicyError";
    this.code = code;
  }
}

function codePointSlice(value: string, length: number): string {
  return [...value].slice(0, length).join("");
}

export function normalizeManagedProcessLabel(label: unknown, command: string): string {
  const candidate = typeof label === "string" ? label : command.trim().split(/\s+/u).slice(0, 3).join(" ");
  const clean = candidate
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return codePointSlice(clean || "Managed process", MANAGED_PROCESS_LIMITS.labelCodePoints);
}

export function validateManagedProcessCommand(command: unknown, allowLanBind = false): string {
  if (typeof command !== "string" || !command.trim()) {
    throw new ManagedProcessPolicyError("PROCESS_COMMAND_BLOCKED", "command is required");
  }
  if (Buffer.byteLength(command, "utf8") > MANAGED_PROCESS_LIMITS.commandBytes) {
    throw new ManagedProcessPolicyError("PROCESS_COMMAND_BLOCKED", "command exceeds the 32 KiB limit");
  }
  if (command.includes("\0") || command.includes("\uFFFD")) {
    throw new ManagedProcessPolicyError("PROCESS_COMMAND_BLOCKED", "command contains invalid characters");
  }
  for (const blocked of BLOCKED_COMMANDS) {
    if (blocked.pattern.test(command)) {
      throw new ManagedProcessPolicyError("PROCESS_COMMAND_BLOCKED", blocked.reason);
    }
  }
  if (!allowLanBind && LAN_BIND_PATTERNS.some((pattern) => pattern.test(command))) {
    throw new ManagedProcessPolicyError(
      "PROCESS_CONFIRMATION_REQUIRED",
      "command appears to bind to all network interfaces; use 127.0.0.1 or start it from the UI after review",
    );
  }
  return command;
}

function canonicalComparison(value: string): string {
  const normalized = path.normalize(value);
  return process.platform === "win32" ? normalized.toLocaleLowerCase("en-US") : normalized;
}

export async function resolveManagedProcessCwd(ownerCwd: string, requestedCwd?: string): Promise<string> {
  if (!path.isAbsolute(ownerCwd)) {
    throw new ManagedProcessPolicyError("PROCESS_CWD_DENIED", "owner workspace is not an absolute path");
  }
  const ownerReal = await realpath(ownerCwd).catch(() => null);
  const targetInput = requestedCwd
    ? path.isAbsolute(requestedCwd)
      ? requestedCwd
      : path.resolve(ownerCwd, requestedCwd)
    : ownerCwd;
  const targetReal = await realpath(targetInput).catch(() => null);
  if (!ownerReal || !targetReal) {
    throw new ManagedProcessPolicyError("PROCESS_CWD_DENIED", "managed process cwd does not exist");
  }
  const relative = path.relative(canonicalComparison(ownerReal), canonicalComparison(targetReal));
  if (relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))) {
    return targetReal;
  }
  throw new ManagedProcessPolicyError(
    "PROCESS_CWD_DENIED",
    "managed process cwd must remain inside the owner workspace",
  );
}

export function sanitizeManagedProcessText(value: string): string {
  return value
    .replace(ANSI_OSC, "")
    .replace(ANSI_CSI, "")
    .replace(ANSI_SINGLE, "")
    .replace(URL_CREDENTIALS, "$1[redacted]@")
    .replace(AUTHORIZATION_HEADER, "$1$2[redacted]")
    .replace(SECRET_CLI_ARGUMENT, "$1[redacted]")
    .replace(SECRET_ASSIGNMENT, (_match, key: string, separator: string) => `${key}${separator}[redacted]`)
    .replace(PI_NONCE, "$1=[redacted]")
    .replace(COMMON_SECRET_TOKEN, "[redacted]")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g, "");
}

export function managedProcessCommandDisplay(command: string): string {
  const value = sanitizeManagedProcessText(command).replace(/\s+/g, " ").trim();
  return codePointSlice(value, 240) + ([...value].length > 240 ? "…" : "");
}

export function managedProcessCommandHash(command: string): string {
  return createHash("sha256").update(command, "utf8").digest("hex").slice(0, 16);
}

export function relativeManagedProcessCwd(ownerCwd: string, cwd: string): string {
  const relative = path.relative(ownerCwd, cwd).replace(/\\/g, "/");
  return relative && !relative.startsWith("../") ? relative : ".";
}

function safeLoopbackUrl(raw: string): string | null {
  try {
    const url = new URL(raw.replace(/[),.;]+$/, ""));
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    const hostname = url.hostname.toLowerCase();
    if (hostname !== "localhost" && hostname !== "127.0.0.1" && hostname !== "[::1]" && hostname !== "::1") {
      return null;
    }
    url.username = "";
    url.password = "";
    url.hash = "";
    for (const key of [...url.searchParams.keys()]) {
      if (/token|key|secret|password|auth|signature/i.test(key)) url.searchParams.set(key, "[redacted]");
    }
    return url.toString();
  } catch {
    return null;
  }
}

export function extractManagedLoopbackEndpoints(
  text: string,
  stream: Exclude<ManagedProcessLogStream, "system">,
  runId: string,
  now = Date.now(),
): ManagedLoopbackEndpoint[] {
  const matches = text.match(/https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::\d{1,5})?(?:\/[^\s<>"']*)?/gi) ?? [];
  const unique = new Set<string>();
  const endpoints: ManagedLoopbackEndpoint[] = [];
  for (const match of matches) {
    const url = safeLoopbackUrl(match);
    if (!url || unique.has(url)) continue;
    unique.add(url);
    endpoints.push({
      id: createHash("sha256").update(`${runId}\0${url}`, "utf8").digest("hex").slice(0, 16),
      url,
      source: stream,
      firstSeenAt: now,
      lastSeenAt: now,
      runId,
    });
    if (endpoints.length >= MANAGED_PROCESS_LIMITS.endpointCount) break;
  }
  return endpoints;
}

export function managedProcessNetworkWarnings(command: string, outputText = ""): string[] {
  const combined = `${command}\n${outputText}`;
  const warnings: string[] = [];
  if (
    LAN_BIND_PATTERNS.some((pattern) => pattern.test(combined)) ||
    /https?:\/\/(?:0\.0\.0\.0|\[?::\]?)(?::\d+)?/i.test(outputText)
  ) {
    warnings.push("Process may be reachable from the local network");
  }
  return warnings;
}

export function normalizeManagedReadBytes(value: unknown, renderer: boolean): number {
  const fallback = renderer
    ? MANAGED_PROCESS_LIMITS.rendererReadDefaultBytes
    : MANAGED_PROCESS_LIMITS.agentReadDefaultBytes;
  const maximum = renderer ? MANAGED_PROCESS_LIMITS.rendererReadMaxBytes : MANAGED_PROCESS_LIMITS.agentReadMaxBytes;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) return fallback;
  return Math.min(value, maximum);
}

export function normalizeManagedWaitMs(value: unknown, forStart = false): number {
  const fallback = forStart ? MANAGED_PROCESS_LIMITS.startWaitDefaultMs : MANAGED_PROCESS_LIMITS.waitDefaultMs;
  const maximum = forStart ? MANAGED_PROCESS_LIMITS.startWaitMaxMs : MANAGED_PROCESS_LIMITS.waitMaxMs;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return fallback;
  return Math.min(Math.floor(value), maximum);
}
