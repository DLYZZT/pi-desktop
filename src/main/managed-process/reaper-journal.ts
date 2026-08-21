import fs from "node:fs";
import path from "node:path";
import type { ManagedProcessReaperRecord } from "../../contract/processes.ts";

const JOURNAL_VERSION = 1;
const JOURNAL_MAX_BYTES = 64 * 1024;
const RECORD_MAX_COUNT = 16;

type ReaperJournal = {
  version: 1;
  revision: number;
  records: ManagedProcessReaperRecord[];
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
  const record = value as Partial<ManagedProcessReaperRecord>;
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
    throw new ReaperJournalError("Invalid reaper record fields");
  }
  return {
    version: 1,
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
    stat = fs.statSync(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, revision: 0, records: [] };
    throw new ReaperJournalError("Could not inspect the managed process reaper journal");
  }
  if (!stat.isFile() || stat.size > JOURNAL_MAX_BYTES)
    throw new ReaperJournalError("Unsafe managed process reaper journal");
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
  const candidate = parsed as Partial<ReaperJournal>;
  if (
    candidate.version !== JOURNAL_VERSION ||
    !Number.isSafeInteger(candidate.revision) ||
    (candidate.revision ?? -1) < 0 ||
    !Array.isArray(candidate.records) ||
    candidate.records.length > RECORD_MAX_COUNT
  ) {
    throw new ReaperJournalError("Unsupported managed process reaper journal");
  }
  const records = candidate.records.map(validateReaperRecord);
  const identities = new Set<string>();
  for (const record of records) {
    const identity = `${record.processId}\0${record.runId}`;
    if (identities.has(identity)) throw new ReaperJournalError("Duplicate managed process reaper record");
    identities.add(identity);
  }
  return { version: 1, revision: candidate.revision!, records };
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
  const serialized = `${JSON.stringify({ version: 1, revision, records: validated }, null, 2)}\n`;
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
