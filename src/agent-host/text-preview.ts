import { constants, type Stats } from "node:fs";
import { open } from "node:fs/promises";
import { StringDecoder } from "node:string_decoder";
import { RpcError } from "../contract/types";

interface PreviewFile {
  stat(): Promise<Pick<Stats, "size" | "isFile">>;
  read(buffer: Buffer, offset: number, length: number, position: number): Promise<{ bytesRead: number }>;
  close(): Promise<void>;
}
type OpenPreviewFile = (filePath: string, flags: number) => Promise<PreviewFile>;

/** Read one UTF-8 prefix plus at most one byte to detect truncation. */
export function createTextPreviewReader(openFile: OpenPreviewFile = open) {
  return async (filePath: string, maxBytes: number): Promise<{ content: string; size: number; truncated: boolean }> => {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 0 || maxBytes >= Number.MAX_SAFE_INTEGER)
      throw new RangeError("Invalid text preview budget");
    // A special file substituted after the caller's path checks must not block
    // the POSIX open before fstat can reject it. Windows uses ordinary file flags.
    const flags = constants.O_RDONLY | (process.platform === "win32" ? 0 : constants.O_NONBLOCK);
    const file = await openFile(filePath, flags);
    try {
      const initial = await file.stat();
      if (!initial.isFile()) throw new RpcError({ code: "BAD_REQUEST", message: "Not a file" });
      const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, maxBytes + 1));
      const decoder = new StringDecoder("utf8");
      const parts: string[] = [];
      let totalRead = 0;
      while (totalRead < maxBytes + 1) {
        const length = Math.min(buffer.length, maxBytes + 1 - totalRead);
        const { bytesRead } = await file.read(buffer, 0, length, totalRead);
        if (bytesRead === 0) break;
        const textBytes = Math.min(bytesRead, Math.max(0, maxBytes - totalRead));
        if (textBytes) parts.push(decoder.write(buffer.subarray(0, textBytes)));
        totalRead += bytesRead;
      }
      const current = await file.stat();
      const truncated = totalRead > maxBytes || current.size > Math.min(totalRead, maxBytes);
      // At a budget boundary, discard an incomplete final code point. At EOF,
      // retain normal UTF-8 decoding behavior for malformed input.
      if (!truncated) parts.push(decoder.end());
      return { content: parts.join(""), size: current.size, truncated };
    } finally {
      await file.close();
    }
  };
}

export const readTextPreview = createTextPreviewReader();
