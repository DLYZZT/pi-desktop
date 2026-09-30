import { createHash, randomUUID } from "node:crypto";
import { createReadStream, renameSync } from "node:fs";
import { mkdir, open, readFile, rm, stat } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline";
import type {
  ExecutionHistoryPage,
  ExecutionPayload,
  ExecutionQuery,
  ExecutionContentChunk,
  ToolExecutionRecord,
} from "../contract/executions";
import { desktopDataRoot } from "./desktop-data-root";

const INLINE_BYTES = 4 * 1024;
const MAX_PAYLOAD_BYTES = 32 * 1024 * 1024;
const MAX_INDEX_RECORDS = 10_000;
const TERMINAL = new Set(["succeeded", "failed", "blocked", "cancelled", "interrupted"]);
export function isTerminalExecution(status: string): boolean {
  return TERMINAL.has(status);
}

function safeId(value: string): string {
  if (!/^[a-zA-Z0-9_-]{1,128}$/u.test(value)) throw new Error("Invalid execution-history session ID");
  return value;
}

/** Append-only event snapshots. Ordinary queries never repair files or mutate native JSONL. */
export class ExecutionLogStore {
  readonly sessionId: string;
  private readonly directory: string;
  private readonly journal: string;
  private queue: Promise<void> = Promise.resolve();
  private sequence = 0;

  constructor(
    sessionId: string,
    private readonly root = desktopDataRoot(),
  ) {
    this.sessionId = safeId(sessionId);
    this.directory = path.join(root, "tool-executions", sessionId);
    this.journal = path.join(root, "tool-executions", `${sessionId}.jsonl`);
  }

  async readLatest(
    query: ExecutionQuery = {},
    anchorIds?: ReadonlySet<string>,
    filter?: { source?: string; excludeTool?: string; project?: boolean },
  ): Promise<ExecutionHistoryPage> {
    const latest = new Map<string, ToolExecutionRecord>();
    let complete = true,
      truncatedTail = false;
    try {
      const size = (await stat(this.journal)).size;
      if (!size) return { records: [], complete: true, truncatedTail: false };
      const lines = createInterface({
        input: createReadStream(this.journal, { encoding: "utf8", end: size - 1 }),
        crlfDelay: Infinity,
      });
      for await (const line of lines) {
        if (!line.trim()) continue;
        let entry: ToolExecutionRecord;
        try {
          entry = JSON.parse(line) as ToolExecutionRecord;
        } catch {
          truncatedTail = true;
          complete = false;
          continue;
        }
        if (
          !entry ||
          typeof entry !== "object" ||
          entry.schemaVersion !== 1 ||
          entry.sessionId !== this.sessionId ||
          typeof entry.executionId !== "string" ||
          !Number.isSafeInteger(entry.sequence) ||
          entry.sequence < 1 ||
          typeof entry.toolName !== "string" ||
          !(isTerminalExecution(entry.status) || entry.status === "requested" || entry.status === "running")
        ) {
          complete = false;
          continue;
        }
        this.sequence = Math.max(this.sequence, entry.sequence);
        if (anchorIds && (!entry.anchorEntryId || !anchorIds.has(entry.anchorEntryId))) continue;
        if (filter?.source && entry.source !== filter.source) continue;
        if (filter?.excludeTool && entry.toolName === filter.excludeTool) continue;
        if (query.executionId && entry.executionId !== query.executionId) continue;
        if (
          query.parentToolCallId &&
          entry.parentToolCallId !== query.parentToolCallId &&
          entry.rootToolCallId !== query.parentToolCallId
        )
          continue;
        latest.delete(entry.executionId);
        latest.set(entry.executionId, entry);
        if (latest.size > MAX_INDEX_RECORDS) {
          latest.delete(latest.keys().next().value!);
          complete = false;
        }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const limit = Math.max(1, Math.min(MAX_INDEX_RECORDS, Number.isSafeInteger(query.limit) ? query.limit! : 50));
    const records = [...latest.values()]
      .filter((entry) => query.beforeSequence === undefined || entry.sequence < query.beforeSequence)
      .sort((a, b) => b.sequence - a.sequence);
    const selected = records.slice(0, limit);
    let remaining = Math.max(0, Math.min(2 * 1024 * 1024, query.maxContentBytes ?? 128 * 1024));
    for (const entry of selected)
      for (const key of ["arguments", "result", "output"] as const) {
        const payload = entry[key];
        if (!payload) continue;
        if (payload.ref) {
          if (!query.includeContent || payload.ref.bytes > remaining) continue;
          const value = await this.readContent(payload.ref.hash, payload.ref.bytes);
          remaining -= payload.ref.bytes;
          entry[key] = { ...payload, value };
        } else if (filter?.project && "value" in payload) {
          const json = JSON.stringify(payload.value),
            bytes = Buffer.byteLength(json);
          if (query.includeContent && bytes <= remaining) remaining -= bytes;
          else {
            const { value: _value, ...metadata } = payload;
            entry[key] = { ...metadata, preview: json.slice(0, 512), contentOmitted: true };
          }
        }
      }
    return {
      records: selected,
      ...(records.length > limit ? { nextBeforeSequence: selected.at(-1)!.sequence } : {}),
      complete,
      truncatedTail,
    };
  }

  async payload(value: unknown): Promise<ExecutionPayload> {
    let json: string;
    try {
      json = JSON.stringify(value ?? null);
      if (typeof json !== "string") return { complete: false, reason: "Payload is not JSON-serializable" };
    } catch {
      return { complete: false, reason: "Result is not JSON-serializable" };
    }
    const bytes = Buffer.byteLength(json);
    if (bytes <= INLINE_BYTES) return { value: JSON.parse(json) as unknown, complete: true };
    const preview = Buffer.from(json).subarray(0, 4096).toString("utf8");
    if (bytes > MAX_PAYLOAD_BYTES)
      return { preview, complete: false, reason: "Execution payload exceeds the 32 MiB storage budget" };
    const hash = createHash("sha256").update(json).digest("hex");
    await mkdir(path.join(this.directory, "content"), { recursive: true, mode: 0o700 });
    const filename = path.join(this.directory, "content", `${hash}.json`),
      temp = `${filename}.${randomUUID()}.tmp`;
    try {
      const handle = await open(temp, "wx", 0o600);
      try {
        await handle.writeFile(json, "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
      renameSync(temp, filename);
    } finally {
      await rm(temp, { force: true });
    }
    return { ref: { hash, bytes }, preview, complete: true };
  }

  async readContent(hash: string, maxBytes: number): Promise<unknown> {
    if (!/^[a-f0-9]{64}$/u.test(hash)) throw new Error("Invalid execution content reference");
    const filename = path.join(this.directory, "content", `${hash}.json`);
    if (
      !Number.isSafeInteger(maxBytes) ||
      maxBytes < 0 ||
      (await stat(filename)).size > Math.min(MAX_PAYLOAD_BYTES, maxBytes)
    )
      throw new Error("Execution content exceeds the read budget");
    const json = await readFile(filename, "utf8");
    if (createHash("sha256").update(json).digest("hex") !== hash)
      throw new Error("Execution content integrity check failed");
    return JSON.parse(json) as unknown;
  }

  async readContentChunk(hash: string, offset: number, maxBytes = 64 * 1024): Promise<ExecutionContentChunk> {
    if (
      !/^[a-f0-9]{64}$/u.test(hash) ||
      !Number.isSafeInteger(offset) ||
      offset < 0 ||
      !Number.isSafeInteger(maxBytes) ||
      maxBytes < 4 ||
      maxBytes > 2097152
    )
      throw new Error("Invalid execution content chunk");
    const filename = path.join(this.directory, "content", `${hash}.json`),
      handle = await open(filename, "r");
    try {
      const size = (await handle.stat()).size;
      if (size > MAX_PAYLOAD_BYTES || offset > size) throw new Error("Execution content exceeds the read budget");
      const digest = createHash("sha256");
      for await (const chunk of createReadStream(filename, {
        fd: handle.fd,
        autoClose: false,
        start: 0,
        end: size - 1,
      }))
        digest.update(chunk);
      if (digest.digest("hex") !== hash) throw new Error("Execution content integrity check failed");
      const bytes = Buffer.alloc(Math.min(maxBytes, size - offset));
      await handle.read(bytes, 0, bytes.length, offset);
      if (bytes.length && (bytes[0]! & 0xc0) === 0x80)
        throw new Error("Execution content offset splits a UTF-8 character");
      const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes, { stream: offset + bytes.length < size });
      const nextOffset = offset + Buffer.byteLength(text);
      return { text, offset, totalBytes: size, ...(nextOffset < size ? { nextOffset } : {}) };
    } finally {
      await handle.close();
    }
  }

  append(record: Omit<ToolExecutionRecord, "schemaVersion" | "sequence" | "sessionId">): Promise<ToolExecutionRecord> {
    let saved!: ToolExecutionRecord;
    const task = this.queue.then(async () => {
      saved = structuredClone({ ...record, schemaVersion: 1, sessionId: this.sessionId, sequence: ++this.sequence });
      await mkdir(path.dirname(this.journal), { recursive: true, mode: 0o700 });
      const handle = await open(this.journal, "a", 0o600);
      try {
        await handle.writeFile(JSON.stringify(saved) + "\n", "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
    });
    this.queue = task.catch(() => undefined);
    return task.then(() => saved);
  }
  async flush(): Promise<void> {
    await this.queue;
  }

  async recoverInterrupted(): Promise<ToolExecutionRecord[]> {
    await this.recoverAppendBoundary();
    const page = await this.readLatest({ limit: MAX_INDEX_RECORDS });
    if (!page.complete)
      throw new Error("Execution journal is incomplete; recovery requires explicit repair before appending");
    const recovered: ToolExecutionRecord[] = [];
    for (const record of page.records)
      if (!isTerminalExecution(record.status))
        recovered.push(
          await this.append({
            ...record,
            status: "interrupted",
            outcomeUnknown: true,
            endedAt: Date.now(),
            error: "Previous Host ended without a durable terminal record",
          }),
        );
    return recovered;
  }

  async copyBranch(targetId: string, anchorIds: ReadonlySet<string>): Promise<void> {
    const target = new ExecutionLogStore(targetId, this.root),
      page = await this.readLatest({ limit: MAX_INDEX_RECORDS }, anchorIds);
    if (!page.complete)
      throw new Error("Execution-history fork exceeds the indexing budget or contains damaged records");
    for (const record of [...page.records].reverse()) {
      if (!record.anchorEntryId || !anchorIds.has(record.anchorEntryId)) continue;
      const copy = { ...record };
      for (const key of ["arguments", "result", "output"] as const)
        if (copy[key]?.ref)
          copy[key] = await target.payload(await this.readContent(copy[key]!.ref!.hash, MAX_PAYLOAD_BYTES));
      await target.append(copy);
    }
  }

  async remove(): Promise<void> {
    await this.flush();
    await rm(this.journal, { force: true });
    await rm(this.directory, { force: true, recursive: true });
  }

  async exportBundle(): Promise<{ records: ToolExecutionRecord[]; content: Record<string, unknown> }> {
    const page = await this.readLatest({ limit: MAX_INDEX_RECORDS });
    if (!page.complete) throw new Error("Cannot export incomplete execution history");
    const content: Record<string, unknown> = {};
    let bytes = Buffer.byteLength(JSON.stringify(page.records));
    if (bytes > MAX_PAYLOAD_BYTES) throw new Error("Execution export exceeds the 32 MiB budget");
    for (const record of page.records)
      for (const payload of [record.arguments, record.result, record.output])
        if (payload?.ref && !(payload.ref.hash in content)) {
          bytes += payload.ref.bytes;
          if (bytes > MAX_PAYLOAD_BYTES) throw new Error("Execution export exceeds the 32 MiB budget");
          content[payload.ref.hash] = await this.readContent(payload.ref.hash, MAX_PAYLOAD_BYTES);
        }
    return { records: page.records, content };
  }

  private async recoverAppendBoundary(): Promise<void> {
    let handle;
    try {
      handle = await open(this.journal, "r+");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    try {
      const size = (await handle.stat()).size;
      if (!size) return;
      const last = Buffer.alloc(1);
      await handle.read(last, 0, 1, size - 1);
      if (last[0] === 10) return;
      const length = Math.min(size, 1024 * 1024),
        tail = Buffer.alloc(length);
      await handle.read(tail, 0, length, size - length);
      const newline = tail.lastIndexOf(10),
        pending = tail.subarray(newline + 1);
      let valid = true;
      try {
        JSON.parse(pending.toString("utf8"));
      } catch {
        valid = false;
      }
      if (valid) await handle.write(Buffer.from("\n"), 0, 1, size);
      else {
        if (newline < 0 && size > length) throw new Error("Execution journal tail exceeds the recovery budget");
        await mkdir(path.join(this.directory, "recovery"), { recursive: true, mode: 0o700 });
        const backup = await open(path.join(this.directory, "recovery", `${randomUUID()}.partial`), "wx", 0o600);
        try {
          await backup.writeFile(pending);
          await backup.sync();
        } finally {
          await backup.close();
        }
        await handle.truncate(size - length + newline + 1);
      }
      await handle.sync();
    } finally {
      await handle.close();
    }
  }
}
