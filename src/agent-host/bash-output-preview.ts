import type { BashOutputPage } from "../contract/types";
import { RpcError } from "../contract/types";
import { openSdkOutputFile } from "./sdk-output-file";

const pageBytes = 64 * 1024;
export async function readBashOutputPage(filename: string, offset: number): Promise<BashOutputPage> {
  if (!Number.isSafeInteger(offset) || offset < 0)
    throw new RpcError({ code: "BAD_REQUEST", message: "Invalid output offset" });
  try {
    const file = await openSdkOutputFile(filename, /^pi-bash-[a-f0-9]{16}\.log$/u);
    if (!file) return { status: "untrusted" };
    try {
      const stat = await file.stat();
      if (offset > stat.size) return { status: "unavailable" };
      const bytes = Buffer.alloc(Math.min(pageBytes, stat.size - offset));
      const { bytesRead } = await file.read(bytes, 0, bytes.length, offset);
      if (bytesRead !== bytes.length) return { status: "unavailable" };
      const text = new TextDecoder("utf-8", { ignoreBOM: true, fatal: true }).decode(bytes, {
        stream: offset + bytesRead < stat.size,
      });
      const next = offset + Buffer.byteLength(text);
      return { status: "ready", text, offset, totalBytes: stat.size, ...(next < stat.size && { nextOffset: next }) };
    } finally {
      await file.close();
    }
  } catch (error) {
    return { status: (error as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : "unavailable" };
  }
}
