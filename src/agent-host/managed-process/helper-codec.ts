export const WINDOWS_HELPER_PROTOCOL_VERSION = 1;
export const WINDOWS_HELPER_HEADER_BYTES = 16;
export const WINDOWS_HELPER_CONTROL_MAX_BYTES = 128 * 1024;
export const WINDOWS_HELPER_BOOTSTRAP_MAX_BYTES = 512 * 1024;
export const WINDOWS_HELPER_OUTPUT_MAX_BYTES = 64 * 1024;

export const WINDOWS_HELPER_KIND = {
  bootstrap: 1,
  commit: 2,
  stdin: 3,
  closeStdin: 4,
  stop: 5,
  ping: 6,
  shutdown: 7,
  reap: 8,
  secureJournalDirectory: 9,
  hello: 0x100,
  prepared: 0x101,
  started: 0x102,
  stdout: 0x103,
  stderr: 0x104,
  outputDropped: 0x105,
  stdinClosed: 0x106,
  stopping: 0x107,
  activeZero: 0x108,
  exit: 0x109,
  error: 0x10a,
  pong: 0x10b,
  reapOutcome: 0x10c,
  journalDirectorySecured: 0x10d,
} as const;

export type WindowsHelperFrame = { kind: number; sequence: number; payload: Buffer };

function payloadLimit(kind: number): number | null {
  if (kind === WINDOWS_HELPER_KIND.bootstrap) return WINDOWS_HELPER_BOOTSTRAP_MAX_BYTES;
  if (kind === WINDOWS_HELPER_KIND.stdout || kind === WINDOWS_HELPER_KIND.stderr)
    return WINDOWS_HELPER_OUTPUT_MAX_BYTES;
  if (Object.values(WINDOWS_HELPER_KIND).includes(kind as never)) return WINDOWS_HELPER_CONTROL_MAX_BYTES;
  return null;
}

export function encodeWindowsHelperFrame(kind: number, sequence: number, payload: Buffer | string): Buffer {
  const body = typeof payload === "string" ? Buffer.from(payload, "utf8") : payload;
  const limit = payloadLimit(kind);
  if (
    limit === null ||
    !Number.isSafeInteger(sequence) ||
    sequence <= 0 ||
    sequence > 0xffff_ffff ||
    body.length > limit
  ) {
    throw new Error("Invalid Windows helper frame");
  }
  const frame = Buffer.allocUnsafe(WINDOWS_HELPER_HEADER_BYTES + body.length);
  frame.write("PIMP", 0, 4, "ascii");
  frame.writeUInt16LE(WINDOWS_HELPER_PROTOCOL_VERSION, 4);
  frame.writeUInt16LE(kind, 6);
  frame.writeUInt32LE(body.length, 8);
  frame.writeUInt32LE(sequence, 12);
  body.copy(frame, WINDOWS_HELPER_HEADER_BYTES);
  return frame;
}

export class WindowsHelperFrameDecoder {
  private buffer = Buffer.alloc(0);
  private expectedSequence = 1;

  push(chunk: Buffer | Uint8Array): WindowsHelperFrame[] {
    if (!Buffer.isBuffer(chunk) && !(chunk instanceof Uint8Array)) throw new Error("Invalid Windows helper bytes");
    const incoming = Buffer.from(chunk);
    if (this.buffer.length + incoming.length > WINDOWS_HELPER_BOOTSTRAP_MAX_BYTES + WINDOWS_HELPER_HEADER_BYTES) {
      throw new Error("Windows helper receive buffer limit exceeded");
    }
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, incoming]) : incoming;
    const frames: WindowsHelperFrame[] = [];
    while (this.buffer.length >= WINDOWS_HELPER_HEADER_BYTES) {
      if (this.buffer.subarray(0, 4).toString("ascii") !== "PIMP") throw new Error("Invalid Windows helper magic");
      if (this.buffer.readUInt16LE(4) !== WINDOWS_HELPER_PROTOCOL_VERSION)
        throw new Error("Windows helper protocol mismatch");
      const kind = this.buffer.readUInt16LE(6);
      const length = this.buffer.readUInt32LE(8);
      const sequence = this.buffer.readUInt32LE(12);
      const limit = payloadLimit(kind);
      if (limit === null || length > limit || sequence !== this.expectedSequence)
        throw new Error("Invalid Windows helper frame header");
      if (this.buffer.length < WINDOWS_HELPER_HEADER_BYTES + length) break;
      this.expectedSequence += 1;
      frames.push({
        kind,
        sequence,
        payload: Buffer.from(this.buffer.subarray(WINDOWS_HELPER_HEADER_BYTES, WINDOWS_HELPER_HEADER_BYTES + length)),
      });
      this.buffer = this.buffer.subarray(WINDOWS_HELPER_HEADER_BYTES + length);
    }
    return frames;
  }

  finish(): void {
    if (this.buffer.length !== 0) throw new Error("Truncated Windows helper frame");
  }
}

export function encodeWindowsHelperJson(kind: number, sequence: number, value: unknown): Buffer {
  return encodeWindowsHelperFrame(kind, sequence, JSON.stringify(value));
}

export function parseWindowsHelperJson(frame: WindowsHelperFrame): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(frame.payload.toString("utf8"));
  } catch {
    throw new Error("Windows helper returned malformed control JSON");
  }
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Windows helper returned an invalid control object");
  return value as Record<string, unknown>;
}
