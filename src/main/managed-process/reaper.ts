import type { ManagedProcessReaperRecord } from "../../contract/processes.ts";
import {
  getProcessStartFingerprint,
  processGroupExists,
  terminatePosixProcessGroup,
} from "../../agent-host/process-tree.ts";
import { readReaperJournal, validateReaperRecord, writeReaperJournal } from "./reaper-journal.ts";
import { spawn } from "node:child_process";
import path from "node:path";
import type { WindowsManagedProcessHelperDescriptor } from "../../shared/windows-managed-process-helper.ts";
import {
  WINDOWS_HELPER_KIND,
  WindowsHelperFrameDecoder,
  encodeWindowsHelperJson,
  parseWindowsHelperJson,
} from "../../agent-host/managed-process/helper-codec.ts";

export type ManagedProcessReaperStatus = {
  ready: boolean;
  revision: number;
  records: number;
  errorCode?: "PLATFORM_UNSUPPORTED" | "JOURNAL_INVALID" | "IDENTITY_UNCERTAIN" | "REAP_FAILED";
};

export interface ManagedProcessReaperOptions {
  platform?: NodeJS.Platform;
  fingerprint?: typeof getProcessStartFingerprint;
  groupExists?: typeof processGroupExists;
  terminateGroup?: typeof terminatePosixProcessGroup;
  log?: (message: string) => void;
  windowsHelper?: WindowsManagedProcessHelperDescriptor;
  reapWindows?: (record: Extract<ManagedProcessReaperRecord, { platform: "win32" }>) => Promise<boolean>;
}

function safeHelperEnvironment(): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const key of ["SystemRoot", "WINDIR"]) if (process.env[key]) environment[key] = process.env[key];
  return environment;
}

export async function secureWindowsReaperDirectory(
  directory: string,
  descriptor: WindowsManagedProcessHelperDescriptor,
  log: (message: string) => void = () => undefined,
): Promise<boolean> {
  if (!path.isAbsolute(directory)) return false;
  return new Promise<boolean>((resolve) => {
    let settled = false;
    let hello = false;
    const finish = (value: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        child.kill();
      } catch {
        // Already exited.
      }
      resolve(value);
    };
    const child = spawn(descriptor.path, ["--reap-stdio-v1"], {
      cwd: path.dirname(descriptor.path),
      env: safeHelperEnvironment(),
      shell: false,
      windowsHide: true,
      stdio: ["pipe", "pipe", "ignore"],
    });
    const decoder = new WindowsHelperFrameDecoder();
    const timer = setTimeout(() => {
      log("managed process Windows journal security helper timed out");
      finish(false);
    }, 3_000);
    timer.unref();
    child.once("error", () => {
      log("managed process Windows journal security helper failed to start");
      finish(false);
    });
    child.once("close", (code) => {
      if (!settled) log(`managed process Windows journal security helper exited code=${code ?? "unknown"}`);
      finish(false);
    });
    child.stdin?.on("error", () => finish(false));
    child.stdout?.on("data", (chunk: Buffer) => {
      try {
        for (const frame of decoder.push(chunk)) {
          const value = parseWindowsHelperJson(frame);
          if (frame.kind === WINDOWS_HELPER_KIND.hello && !hello) {
            if (
              value.protocolVersion !== descriptor.protocolVersion ||
              value.buildId !== descriptor.buildId ||
              value.arch !== descriptor.arch
            ) {
              finish(false);
              return;
            }
            hello = true;
            child.stdin?.write(
              encodeWindowsHelperJson(WINDOWS_HELPER_KIND.secureJournalDirectory, 1, { path: directory }),
            );
          } else if (frame.kind === WINDOWS_HELPER_KIND.journalDirectorySecured && hello && value.secured === true) {
            finish(true);
          } else if (frame.kind === WINDOWS_HELPER_KIND.error) {
            log(
              `managed process Windows journal security error=${typeof value.subcode === "string" ? value.subcode : "invalid"}${typeof value.win32Code === "number" ? ` code=${value.win32Code}` : ""}`,
            );
            finish(false);
          } else {
            log(`managed process Windows journal security unexpected frame kind=${frame.kind}`);
            finish(false);
          }
        }
      } catch {
        finish(false);
      }
    });
  });
}

async function reapWindowsRecord(
  record: Extract<ManagedProcessReaperRecord, { platform: "win32" }>,
  descriptor: WindowsManagedProcessHelperDescriptor,
  log: (message: string) => void,
): Promise<"removed" | "identity-uncertain" | "failed"> {
  return new Promise<"removed" | "identity-uncertain" | "failed">((resolve) => {
    let settled = false;
    let sequence = 1;
    let hello = false;
    const finish = (value: "removed" | "identity-uncertain" | "failed") => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        child.kill();
      } catch {
        // Already exited.
      }
      resolve(value);
    };
    const child = spawn(descriptor.path, ["--reap-stdio-v1"], {
      cwd: path.dirname(descriptor.path),
      env: safeHelperEnvironment(),
      shell: false,
      windowsHide: true,
      stdio: ["pipe", "pipe", "ignore"],
    });
    const decoder = new WindowsHelperFrameDecoder();
    const timer = setTimeout(() => {
      log("managed process Windows reaper helper timed out");
      finish("failed");
    }, 3_000);
    timer.unref();
    child.once("error", () => {
      log("managed process Windows reaper helper failed to start");
      finish("failed");
    });
    child.once("close", (code) => {
      if (!settled) log(`managed process Windows reaper helper exited code=${code ?? "unknown"}`);
      finish("failed");
    });
    child.stdin?.on("error", () => finish("failed"));
    child.stdout?.on("data", (chunk: Buffer) => {
      try {
        for (const frame of decoder.push(chunk)) {
          const value = parseWindowsHelperJson(frame);
          if (frame.kind === WINDOWS_HELPER_KIND.hello && !hello) {
            if (
              value.protocolVersion !== descriptor.protocolVersion ||
              value.buildId !== descriptor.buildId ||
              value.arch !== descriptor.arch
            ) {
              finish("failed");
              return;
            }
            hello = true;
            child.stdin?.write(
              encodeWindowsHelperJson(WINDOWS_HELPER_KIND.reap, sequence++, {
                jobName: record.jobName,
                helperPid: record.helperPid,
                helperStartFingerprint: record.helperStartFingerprint,
                helperBuildId: record.helperBuildId,
                nonce: record.nonce,
              }),
            );
          } else if (frame.kind === WINDOWS_HELPER_KIND.reapOutcome && hello) {
            finish(
              value.outcome === "removed" || value.outcome === "already-empty"
                ? "removed"
                : value.outcome === "identity-uncertain"
                  ? "identity-uncertain"
                  : "failed",
            );
          } else if (frame.kind === WINDOWS_HELPER_KIND.error) {
            log(
              `managed process Windows reaper helper error=${typeof value.subcode === "string" ? value.subcode : "invalid"}`,
            );
            finish("failed");
          } else {
            log(`managed process Windows reaper unexpected frame kind=${frame.kind}`);
            finish("failed");
          }
        }
      } catch {
        finish("failed");
      }
    });
  });
}

export class ManagedProcessReaper {
  private readonly journalPath: string;
  private readonly platform: NodeJS.Platform;
  private readonly fingerprint: typeof getProcessStartFingerprint;
  private readonly groupExists: typeof processGroupExists;
  private readonly terminateGroup: typeof terminatePosixProcessGroup;
  private readonly log: (message: string) => void;
  private readonly windowsHelper?: WindowsManagedProcessHelperDescriptor;
  private readonly reapWindows?: (
    record: Extract<ManagedProcessReaperRecord, { platform: "win32" }>,
  ) => Promise<boolean>;
  private records = new Map<string, ManagedProcessReaperRecord>();
  private revision = 0;
  private ready = false;
  private errorCode: ManagedProcessReaperStatus["errorCode"];

  constructor(journalPath: string, options: ManagedProcessReaperOptions = {}) {
    this.journalPath = journalPath;
    this.platform = options.platform ?? process.platform;
    this.fingerprint = options.fingerprint ?? getProcessStartFingerprint;
    this.groupExists = options.groupExists ?? processGroupExists;
    this.terminateGroup = options.terminateGroup ?? terminatePosixProcessGroup;
    this.log = options.log ?? (() => undefined);
    this.windowsHelper = options.windowsHelper;
    this.reapWindows = options.reapWindows;
  }

  async initialize(): Promise<ManagedProcessReaperStatus> {
    if (this.platform !== "darwin" && this.platform !== "linux" && this.platform !== "win32") {
      this.ready = false;
      this.errorCode = "PLATFORM_UNSUPPORTED";
      return this.status();
    }
    try {
      const journal = readReaperJournal(this.journalPath, this.platform);
      this.revision = journal.revision;
      this.records = new Map(journal.records.map((record) => [this.key(record), record]));
    } catch (error) {
      this.ready = false;
      this.errorCode = "JOURNAL_INVALID";
      this.log(`managed process reaper journal rejected: ${error instanceof Error ? error.name : "unknown"}`);
      return this.status();
    }
    this.ready = this.platform !== "win32" || Boolean(this.windowsHelper || this.reapWindows);
    if (!this.ready) {
      this.errorCode = "REAP_FAILED";
      return this.status();
    }
    if (this.records.size > 0) await this.reapAll();
    return this.status();
  }

  status(): ManagedProcessReaperStatus {
    return {
      ready: this.ready,
      revision: this.revision,
      records: this.records.size,
      ...(this.errorCode ? { errorCode: this.errorCode } : {}),
    };
  }

  register(value: unknown): { journalRevision: number } {
    if (!this.ready) throw new Error("Managed process reaper is not ready");
    const record = validateReaperRecord(value);
    const key = this.key(record);
    const existing = this.records.get(key);
    if (existing && existing.nonce !== record.nonce) throw new Error("Managed process reaper identity conflict");
    this.records.set(key, record);
    this.persist();
    return { journalRevision: this.revision };
  }

  unregister(value: unknown): { journalRevision: number; removed: boolean } {
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw new Error("Invalid reaper unregister request");
    const request = value as { hostInstanceId?: unknown; processId?: unknown; runId?: unknown; nonce?: unknown };
    if (
      typeof request.hostInstanceId !== "string" ||
      typeof request.processId !== "string" ||
      typeof request.runId !== "string" ||
      typeof request.nonce !== "string"
    ) {
      throw new Error("Invalid reaper unregister request");
    }
    const key = `${request.processId}\0${request.runId}`;
    const existing = this.records.get(key);
    if (!existing) return { journalRevision: this.revision, removed: false };
    if (existing.hostInstanceId !== request.hostInstanceId || existing.nonce !== request.nonce) {
      throw new Error("Managed process reaper unregister identity mismatch");
    }
    this.records.delete(key);
    this.persist();
    return { journalRevision: this.revision, removed: true };
  }

  async reapAll(hostInstanceId?: string): Promise<ManagedProcessReaperStatus> {
    if (!this.ready) return this.status();
    const records = [...this.records.values()].filter(
      (record) => !hostInstanceId || record.hostInstanceId === hostInstanceId,
    );
    const outcomes = await Promise.all(records.map(async (record) => ({ record, outcome: await this.reap(record) })));
    let failure: ManagedProcessReaperStatus["errorCode"];
    for (const { record, outcome } of outcomes) {
      if (outcome === "removed") {
        this.records.delete(this.key(record));
      } else if (outcome === "identity-uncertain") {
        failure = "IDENTITY_UNCERTAIN";
      } else if (!failure) {
        failure = "REAP_FAILED";
      }
    }
    if (failure) {
      this.ready = false;
      this.errorCode = failure;
    }
    try {
      this.persist();
    } catch {
      this.ready = false;
      this.errorCode = "JOURNAL_INVALID";
    }
    return this.status();
  }

  private async reap(record: ManagedProcessReaperRecord): Promise<"removed" | "identity-uncertain" | "failed"> {
    if (record.platform === "win32") {
      if (this.platform !== "win32") return "identity-uncertain";
      try {
        const outcome = this.reapWindows
          ? (await this.reapWindows(record))
            ? "removed"
            : "failed"
          : this.windowsHelper
            ? await reapWindowsRecord(record, this.windowsHelper, this.log)
            : "failed";
        if (outcome === "removed") {
          this.log(`managed process reaped process=${this.safeId(record.processId)}`);
          return "removed";
        }
        return outcome;
      } catch {
        return "failed";
      }
    }
    if (this.platform === "win32") return "identity-uncertain";
    if (!this.groupExists(record.pgid)) return "removed";
    const fingerprint = await this.fingerprint(record.pid);
    if (!fingerprint || fingerprint !== record.startFingerprint) {
      this.log(`managed process reap refused identity mismatch process=${this.safeId(record.processId)}`);
      return "identity-uncertain";
    }
    const stopped = await this.terminateGroup(record.pgid, { interruptMs: 500, terminateMs: 1_000, forceMs: 1_000 });
    if (!stopped) {
      this.log(`managed process reap failed process=${this.safeId(record.processId)}`);
      return "failed";
    }
    this.log(`managed process reaped process=${this.safeId(record.processId)}`);
    return "removed";
  }

  private persist(): void {
    this.revision += 1;
    writeReaperJournal(this.journalPath, this.revision, [...this.records.values()]);
  }

  private key(record: Pick<ManagedProcessReaperRecord, "processId" | "runId">): string {
    return `${record.processId}\0${record.runId}`;
  }

  private safeId(value: string): string {
    return value.replace(/[^a-z0-9-]/gi, "").slice(-12);
  }
}
