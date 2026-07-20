import { createHash } from "node:crypto";

const MACHO_64_LE = 0xfeedfacf;
const LC_SEGMENT_64 = 0x19;
const LC_CODE_SIGNATURE = 0x1d;
const MACHO_HEADER_64_BYTES = 32;
const MAX_LOAD_COMMANDS = 4_096;

export interface DarwinCodeDigest {
  sha256: string;
  bytes: number;
}

interface ParsedMachO {
  commandCount: number;
  commandBytes: number;
  linkeditCommands: number[];
  signatureCommand?: { offset: number; size: number; dataOffset: number; dataSize: number };
}

function parseMachO(input: Buffer): ParsedMachO | undefined {
  if (input.length < MACHO_HEADER_64_BYTES || input.readUInt32LE(0) !== MACHO_64_LE) return undefined;
  const commandCount = input.readUInt32LE(16);
  const commandBytes = input.readUInt32LE(20);
  if (
    commandCount > MAX_LOAD_COMMANDS ||
    commandBytes > input.length - MACHO_HEADER_64_BYTES ||
    MACHO_HEADER_64_BYTES + commandBytes > input.length
  ) {
    return undefined;
  }

  const linkeditCommands: number[] = [];
  let signatureCommand: ParsedMachO["signatureCommand"];
  let offset = MACHO_HEADER_64_BYTES;
  const commandsEnd = MACHO_HEADER_64_BYTES + commandBytes;
  for (let index = 0; index < commandCount; index += 1) {
    if (offset + 8 > commandsEnd) return undefined;
    const command = input.readUInt32LE(offset);
    const size = input.readUInt32LE(offset + 4);
    if (size < 8 || size % 8 !== 0 || offset + size > commandsEnd) return undefined;
    if (command === LC_SEGMENT_64) {
      if (size < 72) return undefined;
      const name = input
        .subarray(offset + 8, offset + 24)
        .toString("utf8")
        .replace(/\0.*$/s, "");
      if (name === "__LINKEDIT") linkeditCommands.push(offset);
    } else if (command === LC_CODE_SIGNATURE) {
      if (size !== 16 || signatureCommand) return undefined;
      signatureCommand = {
        offset,
        size,
        dataOffset: input.readUInt32LE(offset + 8),
        dataSize: input.readUInt32LE(offset + 12),
      };
    }
    offset += size;
  }
  if (offset !== commandsEnd || linkeditCommands.length !== 1) return undefined;
  if (
    signatureCommand &&
    (signatureCommand.dataSize === 0 ||
      signatureCommand.dataOffset < commandsEnd ||
      signatureCommand.dataOffset + signatureCommand.dataSize > input.length)
  ) {
    return undefined;
  }
  return { commandCount, commandBytes, linkeditCommands, signatureCommand };
}

export function darwinCodeDigest(input: Buffer, expectedCodeBytes?: number): DarwinCodeDigest | undefined {
  const parsed = parseMachO(input);
  if (!parsed) return undefined;
  const signatureOffset = parsed.signatureCommand?.dataOffset;
  const codeBytes = expectedCodeBytes ?? signatureOffset ?? input.length;
  if (!Number.isSafeInteger(codeBytes) || codeBytes <= 0 || codeBytes > input.length) return undefined;
  if (signatureOffset !== undefined) {
    if (codeBytes > signatureOffset) return undefined;
    for (let offset = codeBytes; offset < signatureOffset; offset += 1) {
      if (input[offset] !== 0) return undefined;
    }
  } else if (codeBytes !== input.length) {
    return undefined;
  }

  const normalized = Buffer.from(input.subarray(0, codeBytes));
  for (const offset of parsed.linkeditCommands) {
    if (offset + 56 > normalized.length) return undefined;
    // codesign grows these two __LINKEDIT fields to cover the replacement signature.
    normalized.fill(0, offset + 32, offset + 40);
    normalized.fill(0, offset + 48, offset + 56);
  }
  if (parsed.signatureCommand) {
    if (parsed.signatureCommand.offset + parsed.signatureCommand.size > normalized.length) return undefined;
    normalized.writeUInt32LE(parsed.commandCount - 1, 16);
    normalized.writeUInt32LE(parsed.commandBytes - parsed.signatureCommand.size, 20);
    normalized.fill(0, parsed.signatureCommand.offset, parsed.signatureCommand.offset + parsed.signatureCommand.size);
  }
  return {
    sha256: createHash("sha256").update(normalized).digest("hex"),
    bytes: codeBytes,
  };
}
