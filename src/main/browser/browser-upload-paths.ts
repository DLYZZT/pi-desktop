import fs from "node:fs";
import path from "node:path";
import { BrowserError } from "./browser-error.ts";

const MAX_FILES = 20;
const MAX_FILE_BYTES = 100 * 1024 * 1024;
const MAX_TOTAL_BYTES = 200 * 1024 * 1024;
const MAX_PATH_CHARS = 4_096;

/**
 * Agent uploads are limited to explicit, existing regular files. The user still
 * approves the file list before Chromium receives it.
 */
export function validateUploadPaths(rawPaths: string[]): string[] {
  if (!Array.isArray(rawPaths) || rawPaths.length === 0 || rawPaths.length > MAX_FILES) {
    throw new BrowserError("UPLOAD_PATH_DENIED", `Select between 1 and ${MAX_FILES} upload files`);
  }
  const seen = new Set<string>();
  let totalBytes = 0;
  return rawPaths.map((value) => {
    if (
      typeof value !== "string" ||
      value.length === 0 ||
      value.length > MAX_PATH_CHARS ||
      /[\0\r\n]/.test(value) ||
      !path.isAbsolute(value)
    ) {
      throw new BrowserError("UPLOAD_PATH_DENIED", "Upload paths must be absolute local files");
    }
    const resolved = path.resolve(value);
    if (seen.has(resolved)) throw new BrowserError("UPLOAD_PATH_DENIED", "Upload paths must be unique");
    seen.add(resolved);
    let stat: fs.Stats;
    try {
      stat = fs.statSync(resolved);
    } catch {
      throw new BrowserError("UPLOAD_PATH_DENIED", "Upload file does not exist");
    }
    if (!stat.isFile()) throw new BrowserError("UPLOAD_PATH_DENIED", "Upload paths must point to regular files");
    if (stat.size > MAX_FILE_BYTES) {
      throw new BrowserError("UPLOAD_PATH_DENIED", "Each upload file must be at most 100 MiB");
    }
    totalBytes += stat.size;
    if (totalBytes > MAX_TOTAL_BYTES) {
      throw new BrowserError("UPLOAD_PATH_DENIED", "Upload batch must be at most 200 MiB");
    }
    return resolved;
  });
}
