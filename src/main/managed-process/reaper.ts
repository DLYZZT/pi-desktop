import type { ManagedProcessReaperRecord } from "../../contract/processes.ts";
import {
  getProcessStartFingerprint,
  processGroupExists,
  terminatePosixProcessGroup,
} from "../../agent-host/process-tree.ts";
import { readReaperJournal, validateReaperRecord, writeReaperJournal } from "./reaper-journal.ts";

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
}

export class ManagedProcessReaper {
  private readonly journalPath: string;
  private readonly platform: NodeJS.Platform;
  private readonly fingerprint: typeof getProcessStartFingerprint;
  private readonly groupExists: typeof processGroupExists;
  private readonly terminateGroup: typeof terminatePosixProcessGroup;
  private readonly log: (message: string) => void;
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
  }

  async initialize(): Promise<ManagedProcessReaperStatus> {
    if (this.platform !== "darwin" && this.platform !== "linux") {
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
    this.ready = true;
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
    for (const record of records) {
      const outcome = await this.reap(record);
      if (outcome === "removed") this.records.delete(this.key(record));
      else if (outcome === "identity-uncertain") {
        this.ready = false;
        this.errorCode = "IDENTITY_UNCERTAIN";
        break;
      } else {
        this.ready = false;
        this.errorCode = "REAP_FAILED";
        break;
      }
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
