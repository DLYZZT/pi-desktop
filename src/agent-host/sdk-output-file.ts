import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

// A macOS GUI launched without TMPDIR and a terminal CLI still share the OS-assigned user temp directory.
let macUserTemp: Promise<string | undefined> | undefined;
function macUserTempDirectory(): Promise<string | undefined> {
  return (macUserTemp ??= promisify(execFile)("/usr/bin/getconf", ["DARWIN_USER_TEMP_DIR"], {
    timeout: 2000,
    maxBuffer: 4096,
  })
    .then(({ stdout }) => realpath(stdout.trim()))
    .catch(() => undefined));
}

/** Resolve the temp directory once and open its direct child without following a replacement link. */
export async function openSdkOutputFile(filename: string, pattern: RegExp) {
  if (!path.isAbsolute(filename) || filename.split(path.sep).includes("..") || !pattern.test(path.basename(filename)))
    return;
  const root = await realpath(path.dirname(filename));
  if (root !== (await realpath(tmpdir())) && (process.platform !== "darwin" || root !== (await macUserTempDirectory())))
    return;
  const candidate = path.join(root, path.basename(filename));
  const stat = await lstat(candidate);
  if (!stat.isFile() || stat.nlink !== 1 || (process.getuid && stat.uid !== process.getuid())) return;
  const handle = await open(candidate, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try {
    const opened = await handle.stat();
    if (opened.isFile() && opened.ino === stat.ino && opened.dev === stat.dev && opened.nlink === 1) return handle;
  } catch (error) {
    await handle.close();
    throw error;
  }
  await handle.close();
}
