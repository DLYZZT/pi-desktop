import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ExecutionPayload } from "../contract/executions";
import type { ExecutionLogStore } from "./execution-log-store";

/** Copy SDK-owned spill files before their temporary path disappears; never follow server-supplied paths. */
export async function captureExecutionOutput(
  store: ExecutionLogStore,
  toolName: string,
  result: unknown,
): Promise<ExecutionPayload | undefined> {
  if (toolName !== "bash" && toolName !== "codemode") return;
  const details = (result as { details?: { fullOutputPath?: unknown } } | undefined)?.details;
  const filename = details?.fullOutputPath;
  if (typeof filename !== "string") return;
  const pattern = toolName === "bash" ? /^pi-bash-[a-f0-9]{16}\.log$/u : /^pi-codemode-[a-f0-9]{16}\.txt$/u;
  try {
    if (
      !path.isAbsolute(filename) ||
      !pattern.test(path.basename(filename)) ||
      (await realpath(path.dirname(filename))) !== (await realpath(tmpdir())) ||
      !(await lstat(filename)).isFile()
    )
      return { complete: false, reason: "Output path is not an SDK-owned temporary file" };
    const handle = await open(filename, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const before = await handle.stat();
      if (!before.isFile() || before.size > 32 * 1024 * 1024)
        return { complete: false, reason: "Full output exceeds the 32 MiB storage budget" };
      const bytes = Buffer.alloc(before.size);
      let offset = 0;
      while (offset < bytes.length) {
        const read = await handle.read(bytes, offset, bytes.length - offset, offset);
        if (!read.bytesRead) break;
        offset += read.bytesRead;
      }
      const payload = await store.payload(bytes.subarray(0, offset).toString("utf8"));
      const after = await handle.stat();
      return offset === before.size && after.size === before.size && after.mtimeMs === before.mtimeMs
        ? payload
        : { ...payload, complete: false, reason: "Output file changed while being captured" };
    } finally {
      await handle.close();
    }
  } catch (error) {
    return { complete: false, reason: `Full output could not be captured: ${(error as Error).message}` };
  }
}
