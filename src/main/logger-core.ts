import fs from "node:fs/promises";
import path from "node:path";

const PRIVATE_KEY_PATTERN = /-----BEGIN [A-Z ]*PRIVATE KEY-----/i;
const BEARER_PATTERN = /\bbearer\s+[a-z0-9._~+/=-]+/gi;
const SECRET_VALUE_PATTERN =
  /((?:["']?)(?:authorization|proxy-authorization|access[_-]?token|refresh[_-]?token|token|password|passwd|secret|client[_-]?secret|api[_-]?key|credential|cookie|set-cookie)(?:["']?)\s*[:=]\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;&]+)/gi;
const URL_CREDENTIAL_PATTERN = /(\b[a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+:[^\s/@]+@/gi;

export function sanitizeLogLine(line: string, maxChars = 16_384): string {
  let sanitized = String(line).replace(/[\r\n\u2028\u2029]+/g, " ");
  if (PRIVATE_KEY_PATTERN.test(sanitized)) return "<redacted-private-key-material>";
  sanitized = sanitized
    .replace(BEARER_PATTERN, "Bearer <redacted>")
    .replace(SECRET_VALUE_PATTERN, "$1<redacted>")
    .replace(URL_CREDENTIAL_PATTERN, "$1<redacted>@");

  if (sanitized.length <= maxChars) return sanitized;
  const suffix = `… [truncated ${sanitized.length - maxChars} chars]`;
  return `${sanitized.slice(0, Math.max(0, maxChars - suffix.length))}${suffix}`;
}

export class HostOutputLineBuffer {
  private readonly emit: (lines: readonly string[]) => void;
  private readonly maxLineChars: number;
  private readonly maxBatchLines: number;
  private currentLine = "";
  private currentLineTruncated = false;
  private batch: string[] = [];

  constructor(emit: (lines: readonly string[]) => void, maxLineChars = 16_384, maxBatchLines = 64) {
    this.emit = emit;
    this.maxLineChars = maxLineChars;
    this.maxBatchLines = maxBatchLines;
  }

  push(chunk: string): void {
    let start = 0;
    for (let index = chunk.indexOf("\n"); index >= 0; index = chunk.indexOf("\n", start)) {
      const segment = chunk.slice(start, index);
      this.appendSegment(segment.endsWith("\r") ? segment.slice(0, -1) : segment);
      this.finishLine();
      start = index + 1;
    }
    this.appendSegment(chunk.slice(start));
    this.emitBatch();
  }

  flush(): void {
    if (this.currentLine || this.currentLineTruncated) this.finishLine();
    this.emitBatch();
  }

  private appendSegment(segment: string): void {
    if (this.currentLineTruncated || !segment) return;
    const remaining = this.maxLineChars - this.currentLine.length;
    if (segment.length <= remaining) {
      this.currentLine += segment;
      return;
    }
    this.currentLine += segment.slice(0, Math.max(0, remaining));
    this.currentLineTruncated = true;
  }

  private finishLine(): void {
    const line = this.currentLine.endsWith("\r") ? this.currentLine.slice(0, -1) : this.currentLine;
    if (line || this.currentLineTruncated) {
      this.batch.push(this.currentLineTruncated ? `${line}… [truncated]` : line);
    }
    this.currentLine = "";
    this.currentLineTruncated = false;
    if (this.batch.length >= this.maxBatchLines) this.emitBatch();
  }

  private emitBatch(): void {
    if (this.batch.length === 0) return;
    const batch = this.batch;
    this.batch = [];
    this.emit(batch);
  }
}

export interface AsyncRotatingFileLoggerOptions {
  filePath: string;
  maxBytes: number;
  maxGenerations: number;
  maxQueueBytes: number;
  flushIntervalMs: number;
  retryIntervalMs?: number;
  onError?: (error: unknown) => void;
}

export class AsyncRotatingFileLogger {
  private readonly options: AsyncRotatingFileLoggerOptions;
  private readonly maxQueueBytes: number;
  private readonly retryIntervalMs: number;
  private queue: string[] = [];
  private queuedBytes = 0;
  private droppedEntries = 0;
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private writeChain: Promise<void> = Promise.resolve();

  constructor(options: AsyncRotatingFileLoggerOptions) {
    this.options = options;
    this.maxQueueBytes = Math.max(1, Math.min(options.maxQueueBytes, options.maxBytes));
    this.retryIntervalMs = options.retryIntervalMs ?? 1_000;
  }

  append(entries: readonly string[]): void {
    for (const entry of entries) {
      const bounded = this.boundEntry(entry);
      this.queue.push(bounded);
      this.queuedBytes += Buffer.byteLength(bounded);
      this.trimQueue();
    }
    this.scheduleFlush(this.options.flushIntervalMs);
  }

  flush(): Promise<void> {
    this.clearFlushTimer();
    const operation = this.writeChain.then(() => this.flushQueuedEntries());
    this.writeChain = operation.catch(() => undefined);
    return operation;
  }

  private async flushQueuedEntries(): Promise<void> {
    if (this.queue.length === 0) return;

    const entries = this.queue;
    const droppedEntries = this.droppedEntries;
    this.queue = [];
    this.queuedBytes = 0;
    this.droppedEntries = 0;
    const droppedNotice = droppedEntries > 0 ? `[logger] dropped ${droppedEntries} queued entries\n` : "";
    const payload = `${droppedNotice}${entries.join("")}`;

    try {
      await this.writePayload(payload);
    } catch (error) {
      this.restoreFailedEntries(entries, droppedEntries);
      this.options.onError?.(error);
      this.scheduleFlush(this.retryIntervalMs);
      return;
    }

    if (this.queue.length > 0) this.scheduleFlush(this.options.flushIntervalMs);
  }

  private async writePayload(payload: string): Promise<void> {
    await fs.mkdir(path.dirname(this.options.filePath), { recursive: true, mode: 0o700 });
    const payloadBytes = Buffer.byteLength(payload);
    const currentBytes = await this.currentFileSize();
    if (currentBytes > 0 && currentBytes + payloadBytes > this.options.maxBytes) {
      await this.rotate();
    }
    await fs.appendFile(this.options.filePath, payload, { encoding: "utf8", mode: 0o600 });
  }

  private async currentFileSize(): Promise<number> {
    try {
      return (await fs.stat(this.options.filePath)).size;
    } catch (error) {
      if (isMissingFileError(error)) return 0;
      throw error;
    }
  }

  private async rotate(): Promise<void> {
    if (this.options.maxGenerations <= 0) {
      await fs.writeFile(this.options.filePath, "", { mode: 0o600 });
      return;
    }

    await ignoreMissing(() => fs.unlink(`${this.options.filePath}.${this.options.maxGenerations}`));
    for (let generation = this.options.maxGenerations - 1; generation >= 1; generation -= 1) {
      await ignoreMissing(() =>
        fs.rename(`${this.options.filePath}.${generation}`, `${this.options.filePath}.${generation + 1}`),
      );
    }
    await ignoreMissing(() => fs.rename(this.options.filePath, `${this.options.filePath}.1`));
  }

  private restoreFailedEntries(entries: readonly string[], droppedEntries: number): void {
    this.queue = [...entries, ...this.queue];
    this.queuedBytes = this.queue.reduce((total, entry) => total + Buffer.byteLength(entry), 0);
    this.droppedEntries += droppedEntries;
    this.trimQueue();
  }

  private trimQueue(): void {
    while (this.queuedBytes > this.maxQueueBytes && this.queue.length > 1) {
      const removed = this.queue.shift();
      if (removed === undefined) break;
      this.queuedBytes -= Buffer.byteLength(removed);
      this.droppedEntries += 1;
    }
  }

  private boundEntry(entry: string): string {
    const bytes = Buffer.from(entry);
    if (bytes.length <= this.maxQueueBytes) return entry;
    let end = this.maxQueueBytes;
    let bounded = bytes.subarray(0, end).toString("utf8");
    while (Buffer.byteLength(bounded) > this.maxQueueBytes && end > 0) {
      end -= 1;
      bounded = bytes.subarray(0, end).toString("utf8");
    }
    return bounded;
  }

  private scheduleFlush(delayMs: number): void {
    if (this.flushTimer || this.queue.length === 0) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      void this.flush();
    }, delayMs);
    this.flushTimer.unref();
  }

  private clearFlushTimer(): void {
    if (!this.flushTimer) return;
    clearTimeout(this.flushTimer);
    this.flushTimer = null;
  }
}

function isMissingFileError(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === "ENOENT";
}

async function ignoreMissing(action: () => Promise<unknown>): Promise<void> {
  try {
    await action();
  } catch (error) {
    if (!isMissingFileError(error)) throw error;
  }
}
