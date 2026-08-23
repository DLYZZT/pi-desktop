import fs from "node:fs";
import path from "node:path";
import type { ManagedProcessReaperRecord } from "../../contract/processes.ts";

const JOURNAL_VERSION = 2;
const JOURNAL_MAX_BYTES = 64 * 1024;
const RECORD_MAX_COUNT = 16;

type ReaperJournal = {
  version: 2;
  revision: number;
  records: ManagedProcessReaperRecord[];
};

type LegacyReaperRecordV1 = {
  version: 1;
  processId: string;
  runId: string;
  hostInstanceId: string;
  pid: number;
  pgid: number;
  startFingerprint: string;
  nonce: string;
  createdAt: number;
};

export class ReaperJournalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReaperJournalError";
  }
}

function safeString(value: unknown, maxLength: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maxLength && !/[\0\r\n]/.test(value);
}

export function validateReaperRecord(value: unknown): ManagedProcessReaperRecord {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new ReaperJournalError("Invalid reaper record");
  const record = value as Record<string, unknown>;
  if (
    record.version !== 2 ||
    !safeString(record.processId, 128) ||
    !safeString(record.runId, 128) ||
    !safeString(record.hostInstanceId, 128) ||
    !safeString(record.nonce, 128) ||
    !Number.isSafeInteger(record.createdAt) ||
    (record.createdAt as number) <= 0
  ) {
    throw new ReaperJournalError("Invalid reaper record fields");
  }
  const common = {
    version: 2 as const,
    processId: record.processId,
    runId: record.runId,
    hostInstanceId: record.hostInstanceId,
    nonce: record.nonce,
    createdAt: record.createdAt as number,
  };
  if (record.platform === "posix") {
    if (
      !safeString(record.startFingerprint, 256) ||
      !Number.isSafeInteger(record.pid) ||
      (record.pid as number) <= 1 ||
      !Number.isSafeInteger(record.pgid) ||
      (record.pgid as number) <= 1 ||
      record.pid !== record.pgid
    ) {
      throw new ReaperJournalError("Invalid POSIX reaper record fields");
    }
    return {
      ...common,
      platform: "posix",
      pid: record.pid as number,
      pgid: record.pgid as number,
      startFingerprint: record.startFingerprint,
    };
  }
  if (record.platform === "win32") {
    if (
      !Number.isSafeInteger(record.helperPid) ||
      (record.helperPid as number) <= 1 ||
      !safeString(record.helperStartFingerprint, 512) ||
      !safeString(record.helperBuildId, 128) ||
      !safeString(record.jobName, 128) ||
      !/^Local\\PiDesktop\.Managed\.[a-f0-9]{64}$/u.test(record.jobName) ||
      !/^[a-f0-9]{64}$/u.test(record.nonce) ||
      !record.jobName.endsWith(record.nonce)
    ) {
      throw new ReaperJournalError("Invalid Windows reaper record fields");
    }
    return {
      ...common,
      platform: "win32",
      helperPid: record.helperPid as number,
      helperStartFingerprint: record.helperStartFingerprint,
      jobName: record.jobName,
      helperBuildId: record.helperBuildId,
    };
  }
  throw new ReaperJournalError("Invalid reaper record platform");
}

function validateLegacyRecord(value: unknown): ManagedProcessReaperRecord {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new ReaperJournalError("Invalid legacy reaper record");
  const record = value as Partial<LegacyReaperRecordV1>;
  if (
    record.version !== 1 ||
    !safeString(record.processId, 128) ||
    !safeString(record.runId, 128) ||
    !safeString(record.hostInstanceId, 128) ||
    !safeString(record.startFingerprint, 256) ||
    !safeString(record.nonce, 128) ||
    !Number.isSafeInteger(record.pid) ||
    (record.pid ?? 0) <= 1 ||
    !Number.isSafeInteger(record.pgid) ||
    (record.pgid ?? 0) <= 1 ||
    record.pid !== record.pgid ||
    !Number.isSafeInteger(record.createdAt) ||
    (record.createdAt ?? 0) <= 0
  ) {
    throw new ReaperJournalError("Invalid legacy reaper record fields");
  }
  return {
    version: 2,
    platform: "posix",
    processId: record.processId,
    runId: record.runId,
    hostInstanceId: record.hostInstanceId,
    pid: record.pid!,
    pgid: record.pgid!,
    startFingerprint: record.startFingerprint,
    nonce: record.nonce,
    createdAt: record.createdAt!,
  };
}

export function readReaperJournal(filePath: string, platform: NodeJS.Platform = process.platform): ReaperJournal {
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { version: 2, revision: 0, records: [] };
    throw new ReaperJournalError("Could not inspect the managed process reaper journal");
  }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > JOURNAL_MAX_BYTES)
    throw new ReaperJournalError("Unsafe managed process reaper journal");
  if (platform === "win32") {
    try {
      const parent = fs.lstatSync(path.dirname(filePath));
      if (!parent.isDirectory() || parent.isSymbolicLink()) {
        throw new ReaperJournalError("Unsafe managed process reaper journal directory");
      }
    } catch (error) {
      if (error instanceof ReaperJournalError) throw error;
      throw new ReaperJournalError("Could not inspect the managed process reaper journal directory");
    }
  }
  if (platform !== "win32" && (stat.mode & 0o077) !== 0) {
    throw new ReaperJournalError("Managed process reaper journal permissions are too broad");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    throw new ReaperJournalError("Managed process reaper journal is malformed");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    throw new ReaperJournalError("Invalid reaper journal");
  const candidate = parsed as { version?: unknown; revision?: unknown; records?: unknown };
  if (
    (candidate.version !== 1 && candidate.version !== JOURNAL_VERSION) ||
    typeof candidate.revision !== "number" ||
    !Number.isSafeInteger(candidate.revision) ||
    candidate.revision < 0 ||
    !Array.isArray(candidate.records) ||
    candidate.records.length > RECORD_MAX_COUNT
  ) {
    throw new ReaperJournalError("Unsupported managed process reaper journal");
  }
  const records = candidate.records.map(candidate.version === 1 ? validateLegacyRecord : validateReaperRecord);
  const identities = new Set<string>();
  for (const record of records) {
    const identity = `${record.processId}\0${record.runId}`;
    if (identities.has(identity)) throw new ReaperJournalError("Duplicate managed process reaper record");
    identities.add(identity);
  }
  return { version: 2, revision: candidate.revision, records };
}

export function writeReaperJournal(
  filePath: string,
  revision: number,
  records: readonly ManagedProcessReaperRecord[],
): void {
  if (!Number.isSafeInteger(revision) || revision < 0 || records.length > RECORD_MAX_COUNT) {
    throw new ReaperJournalError("Invalid managed process reaper journal update");
  }
  if (records.length === 0) {
    try {
      fs.unlinkSync(filePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    return;
  }
  const validated = records.map(validateReaperRecord);
  const serialized = `${JSON.stringify({ version: 2, revision, records: validated }, null, 2)}\n`;
  if (Buffer.byteLength(serialized, "utf8") > JOURNAL_MAX_BYTES)
    throw new ReaperJournalError("Reaper journal exceeds its limit");
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const temporaryPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temporaryPath, serialized, { encoding: "utf8", mode: 0o600, flag: "wx" });
  try {
    fs.renameSync(temporaryPath, filePath);
    if (process.platform !== "win32") fs.chmodSync(filePath, 0o600);
  } catch (error) {
    try {
      fs.unlinkSync(temporaryPath);
    } catch {
      /* ignore cleanup failure */
    }
    throw error;
  }
}
