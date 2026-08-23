import { StringDecoder } from "node:string_decoder";
import type {
  ManagedProcessLogGap,
  ManagedProcessLogRecord,
  ManagedProcessLogStream,
  ManagedProcessOutputSummary,
} from "../../contract/processes.ts";
import { MANAGED_PROCESS_LIMITS, sanitizeManagedProcessText } from "../../shared/managed-process-policy.ts";

export interface ManagedOutputReadResult {
  fromCursor: string;
  nextCursor: string;
  earliestCursor: string;
  records: ManagedProcessLogRecord[];
  truncated: boolean;
  gap?: ManagedProcessLogGap;
}

function recordBytes(record: Pick<ManagedProcessLogRecord, "text">): number {
  return Buffer.byteLength(record.text, "utf8");
}

export function managedProcessCursor(runId: string, seq: number): string {
  return `${runId}:${Math.max(0, Math.floor(seq))}`;
}

export function parseManagedProcessCursor(cursor: string, expectedRunId: string): number | null {
  const separator = cursor.lastIndexOf(":");
  if (separator <= 0 || cursor.slice(0, separator) !== expectedRunId) return null;
  const value = Number(cursor.slice(separator + 1));
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

export class ManagedProcessOutputBuffer {
  readonly runId: string;
  private readonly maxBytes: number;
  private readonly maxRecords: number;
  private records: ManagedProcessLogRecord[] = [];
  private head = 0;
  private nextSeq = 1;
  private bytes = 0;
  private droppedBytes = 0;
  private droppedRecords = 0;

  constructor(
    runId: string,
    maxBytes = MANAGED_PROCESS_LIMITS.processBytes,
    maxRecords = MANAGED_PROCESS_LIMITS.processRecords,
  ) {
    this.runId = runId;
    this.maxBytes = maxBytes;
    this.maxRecords = maxRecords;
  }

  append(stream: ManagedProcessLogStream, text: string, timestamp = Date.now()): ManagedProcessLogRecord | null {
    const sanitized = sanitizeManagedProcessText(text);
    if (!sanitized) return null;
    const record: ManagedProcessLogRecord = {
      seq: this.nextSeq++,
      timestamp,
      stream,
      text: sanitized,
      runId: this.runId,
    };
    this.records.push(record);
    this.bytes += recordBytes(record);
    this.trimToLimits();
    return record;
  }

  dropOldest(): boolean {
    const record = this.records[this.head];
    if (!record) return false;
    this.head += 1;
    const bytes = recordBytes(record);
    this.bytes -= bytes;
    this.droppedBytes += bytes;
    this.droppedRecords += 1;
    if (this.head >= 4_096 && this.head * 2 >= this.records.length) {
      this.records = this.records.slice(this.head);
      this.head = 0;
    }
    return true;
  }

  read(
    cursor: string | undefined,
    maxBytes: number,
    streams?: readonly ManagedProcessLogStream[],
  ): ManagedOutputReadResult {
    const earliestSeq = this.records[this.head]?.seq ?? this.nextSeq;
    const latestSeq = this.nextSeq - 1;
    const parsed = cursor ? parseManagedProcessCursor(cursor, this.runId) : earliestSeq - 1;
    const requestedSeq = parsed ?? earliestSeq - 1;
    const fromCursor = managedProcessCursor(this.runId, requestedSeq);
    const gap = requestedSeq < earliestSeq - 1 ? this.gap() : undefined;
    const startingSeq = Math.max(requestedSeq + 1, earliestSeq);
    const streamSet = streams?.length ? new Set(streams) : null;
    const selected: ManagedProcessLogRecord[] = [];
    let selectedBytes = 0;
    let nextSeq = Math.max(requestedSeq, earliestSeq - 1);
    let truncated = false;

    for (let index = this.head; index < this.records.length; index += 1) {
      const record = this.records[index];
      if (record.seq < startingSeq) continue;
      if (streamSet && !streamSet.has(record.stream)) {
        nextSeq = record.seq;
        continue;
      }
      const bytes = recordBytes(record);
      if (selected.length > 0 && selectedBytes + bytes > maxBytes) {
        truncated = true;
        break;
      }
      selected.push({ ...record });
      selectedBytes += bytes;
      nextSeq = record.seq;
      if (selectedBytes >= maxBytes) {
        truncated = record.seq < latestSeq;
        break;
      }
    }

    if (!truncated && nextSeq < latestSeq && selected.length === 0) nextSeq = latestSeq;
    return {
      fromCursor,
      nextCursor: managedProcessCursor(this.runId, nextSeq),
      earliestCursor: managedProcessCursor(this.runId, earliestSeq - 1),
      records: selected,
      truncated,
      ...(gap ? { gap } : {}),
    };
  }

  summary(): ManagedProcessOutputSummary {
    const earliestSeq = this.records[this.head]?.seq ?? this.nextSeq;
    return {
      earliestCursor: managedProcessCursor(this.runId, earliestSeq - 1),
      latestCursor: managedProcessCursor(this.runId, this.nextSeq - 1),
      retainedBytes: this.bytes,
      droppedBytes: this.droppedBytes,
      droppedRecords: this.droppedRecords,
    };
  }

  allRecords(): ManagedProcessLogRecord[] {
    return this.records.slice(this.head).map((record) => ({ ...record }));
  }

  retainedBytes(): number {
    return this.bytes;
  }

  private trimToLimits(): void {
    while (this.records.length - this.head > this.maxRecords || this.bytes > this.maxBytes) {
      if (!this.dropOldest()) break;
    }
  }

  private gap(): ManagedProcessLogGap | undefined {
    if (this.droppedRecords <= 0 && this.droppedBytes <= 0) return undefined;
    return { droppedBytes: this.droppedBytes, droppedRecords: this.droppedRecords };
  }
}

type DecoderState = {
  decoder: StringDecoder;
  line: string;
  retainedBytes: number;
  omittedBytes: number;
  carriageReturn: boolean;
};

export class ManagedProcessOutputDecoder {
  private readonly onLine: (stream: "stdout" | "stderr", line: string) => void;
  private readonly onEncodingWarning?: () => void;
  private decodedCharacters = 0;
  private replacementCharacters = 0;
  private encodingWarningSent = false;
  private readonly states: Record<"stdout" | "stderr", DecoderState> = {
    stdout: this.createState(),
    stderr: this.createState(),
  };

  constructor(onLine: (stream: "stdout" | "stderr", line: string) => void, onEncodingWarning?: () => void) {
    this.onLine = onLine;
    this.onEncodingWarning = onEncodingWarning;
  }

  write(stream: "stdout" | "stderr", chunk: Buffer | string): void {
    const state = this.states[stream];
    const decoded = typeof chunk === "string" ? chunk : state.decoder.write(chunk);
    if (!this.encodingWarningSent) {
      if (!/[\u{10000}-\u{10FFFF}\uFFFD]/u.test(decoded)) {
        this.decodedCharacters += decoded.length;
      } else {
        for (const character of decoded) {
          this.decodedCharacters += 1;
          if (character === "\uFFFD") this.replacementCharacters += 1;
        }
      }
      if (
        this.decodedCharacters >= 32 &&
        this.replacementCharacters >= 4 &&
        this.replacementCharacters * 10 >= this.decodedCharacters
      ) {
        this.encodingWarningSent = true;
        this.onEncodingWarning?.();
      }
    }
    this.consume(stream, state, decoded);
  }

  end(stream: "stdout" | "stderr"): void {
    const state = this.states[stream];
    this.consume(stream, state, state.decoder.end());
    if (state.carriageReturn || state.line || state.omittedBytes) this.flush(stream, state);
  }

  private createState(): DecoderState {
    return { decoder: new StringDecoder("utf8"), line: "", retainedBytes: 0, omittedBytes: 0, carriageReturn: false };
  }

  private consume(stream: "stdout" | "stderr", state: DecoderState, value: string): void {
    let offset = 0;
    while (offset < value.length) {
      if (state.carriageReturn) {
        state.carriageReturn = false;
        if (value[offset] === "\n") {
          this.flush(stream, state);
          offset += 1;
          continue;
        }
        state.line = "";
        state.retainedBytes = 0;
        state.omittedBytes = 0;
      }

      const carriageReturn = value.indexOf("\r", offset);
      const lineFeed = value.indexOf("\n", offset);
      const boundary =
        carriageReturn < 0 ? lineFeed : lineFeed < 0 ? carriageReturn : Math.min(carriageReturn, lineFeed);
      const end = boundary < 0 ? value.length : boundary;
      this.appendSegment(state, value.slice(offset, end));
      if (boundary < 0) break;
      offset = boundary + 1;
      if (value[boundary] === "\r") {
        state.carriageReturn = true;
        continue;
      }
      this.flush(stream, state);
    }
  }

  private appendSegment(state: DecoderState, segment: string): void {
    if (!segment) return;
    const segmentBytes = Buffer.byteLength(segment, "utf8");
    const remaining = MANAGED_PROCESS_LIMITS.lineBytes - state.retainedBytes;
    if (segmentBytes <= remaining) {
      state.line += segment;
      state.retainedBytes += segmentBytes;
      return;
    }
    if (remaining <= 0) {
      state.omittedBytes += segmentBytes;
      return;
    }
    let retained = "";
    let retainedBytes = 0;
    let omittedBytes = 0;
    for (const character of segment) {
      const bytes = Buffer.byteLength(character, "utf8");
      if (retainedBytes + bytes <= remaining) {
        retained += character;
        retainedBytes += bytes;
      } else {
        omittedBytes += bytes;
      }
    }
    state.line += retained;
    state.retainedBytes += retainedBytes;
    state.omittedBytes += omittedBytes;
  }

  private flush(stream: "stdout" | "stderr", state: DecoderState): void {
    const suffix = state.omittedBytes > 0 ? ` <line truncated: ${state.omittedBytes} bytes>` : "";
    this.onLine(stream, `${state.line}${suffix}`);
    state.line = "";
    state.retainedBytes = 0;
    state.omittedBytes = 0;
    state.carriageReturn = false;
  }
}
