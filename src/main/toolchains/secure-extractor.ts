import fs from "node:fs";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import * as tar from "tar";
import * as yauzl from "yauzl";
import type { ToolchainArchiveFormat } from "../../shared/toolchains/catalog-schema.ts";
import { ToolchainError } from "../../shared/toolchains/errors.ts";

const MAX_ARCHIVE_ENTRIES = 100_000;
const ABSOLUTE_ARCHIVE_PATH = /^(?:\/|\\|[A-Za-z]:[\\/]|\\\\)/;

export interface ExtractionLimits {
  maxEntries?: number;
  maxExtractedBytes: number;
}

export function normalizeArchiveEntryPath(value: string): string {
  if (!value || value.includes("\0") || value.includes("\\") || ABSOLUTE_ARCHIVE_PATH.test(value)) {
    throw new Error("Archive contains an unsafe path");
  }
  const normalized = path.posix.normalize(value.replace(/^\.\//, ""));
  if (!normalized || normalized === "." || normalized === ".." || normalized.startsWith("../")) {
    throw new Error("Archive path escapes the staging directory");
  }
  return normalized.replace(/\/$/, "");
}

export function validateArchiveLink(entryPath: string, linkPath: string, hardLink = false): void {
  if (!linkPath || linkPath.includes("\0") || linkPath.includes("\\") || ABSOLUTE_ARCHIVE_PATH.test(linkPath)) {
    throw new Error("Archive contains an unsafe link");
  }
  const normalizedEntry = normalizeArchiveEntryPath(entryPath);
  const resolved = path.posix.normalize(
    hardLink ? linkPath.replace(/^\.\//, "") : path.posix.join(path.posix.dirname(normalizedEntry), linkPath),
  );
  if (!resolved || resolved === ".." || resolved.startsWith("../") || path.posix.isAbsolute(resolved)) {
    throw new Error("Archive link escapes the staging directory");
  }
}

function outputPath(destination: string, entryPath: string): string {
  const segments = normalizeArchiveEntryPath(entryPath).split("/");
  const target = path.resolve(destination, ...segments);
  const root = `${path.resolve(destination)}${path.sep}`;
  if (!target.startsWith(root)) throw new Error("Archive path escapes the staging directory");
  return target;
}

async function extractTarGzip(
  archivePath: string,
  destination: string,
  limits: Required<ExtractionLimits>,
): Promise<void> {
  let entries = 0;
  let extractedBytes = 0;
  let validationError: Error | undefined;
  const validateEntry = (entryPath: string, entry: { size?: number; type?: string; linkpath?: string }): boolean => {
    try {
      const normalized = normalizeArchiveEntryPath(entryPath);
      entries += 1;
      if (entries > limits.maxEntries) throw new Error("Archive contains too many entries");
      extractedBytes += Math.max(0, typeof entry.size === "number" ? entry.size : 0);
      if (extractedBytes > limits.maxExtractedBytes) throw new Error("Archive expands beyond its byte limit");

      const type = String(entry.type ?? "File");
      if (type === "SymbolicLink" || type === "Link") {
        validateArchiveLink(normalized, typeof entry.linkpath === "string" ? entry.linkpath : "", type === "Link");
      } else if (!["File", "OldFile", "ContiguousFile", "Directory"].includes(type)) {
        throw new Error(`Archive contains unsupported entry type: ${type}`);
      }
      return true;
    } catch (error) {
      validationError ??= error instanceof Error ? error : new Error("Archive validation failed");
      return false;
    }
  };

  await tar.t({
    file: archivePath,
    gzip: true,
    strict: true,
    onentry(entry) {
      validateEntry(entry.path, entry);
    },
  });
  if (validationError) throw validationError;

  let extractionError: Error | undefined;
  await tar.x({
    file: archivePath,
    cwd: destination,
    gzip: true,
    strict: true,
    preservePaths: false,
    filter(entryPath, entry) {
      try {
        const normalized = normalizeArchiveEntryPath(entryPath);
        const type = "type" in entry ? String(entry.type) : "File";
        if (type === "SymbolicLink" || type === "Link") {
          const linkPath = "linkpath" in entry && typeof entry.linkpath === "string" ? entry.linkpath : "";
          validateArchiveLink(normalized, linkPath, type === "Link");
        }
        return ["File", "OldFile", "ContiguousFile", "Directory", "SymbolicLink", "Link"].includes(type);
      } catch (error) {
        extractionError ??= error instanceof Error ? error : new Error("Archive validation failed");
        return false;
      }
    },
  });
  if (extractionError) throw extractionError;
}

function unixMode(entry: yauzl.Entry): number {
  return (entry.externalFileAttributes >>> 16) & 0xffff;
}

async function extractZip(archivePath: string, destination: string, limits: Required<ExtractionLimits>): Promise<void> {
  const zip = await yauzl.openPromise(archivePath, {
    autoClose: false,
    lazyEntries: true,
    decodeStrings: true,
    validateEntrySizes: true,
    strictFileNames: true,
  });
  let entries = 0;
  let extractedBytes = 0;
  try {
    for await (const entry of zip.eachEntry()) {
      entries += 1;
      if (entries > limits.maxEntries) throw new Error("Archive contains too many entries");
      if (entry.isEncrypted() || !entry.canDecodeFileData()) throw new Error("Archive entry cannot be decoded safely");
      const normalized = normalizeArchiveEntryPath(entry.fileName);
      const mode = unixMode(entry);
      if ((mode & 0o170000) === 0o120000) throw new Error("ZIP symbolic links are not accepted");
      extractedBytes += entry.uncompressedSize;
      if (extractedBytes > limits.maxExtractedBytes) throw new Error("Archive expands beyond its byte limit");
      const target = outputPath(destination, normalized);
      if (entry.fileName.endsWith("/")) {
        fs.mkdirSync(target, { recursive: true, mode: 0o755 });
        continue;
      }
      fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o755 });
      const stream = await zip.openReadStreamPromise(entry);
      const executable = (mode & 0o111) !== 0 || /\.(?:exe|cmd|bat)$/i.test(target);
      await pipeline(stream, fs.createWriteStream(target, { flags: "wx", mode: executable ? 0o755 : 0o644 }));
    }
  } finally {
    zip.close();
  }
}

export async function extractRuntimeArchive(
  archivePath: string,
  destination: string,
  archive: ToolchainArchiveFormat,
  limits: ExtractionLimits,
): Promise<void> {
  const normalizedLimits: Required<ExtractionLimits> = {
    maxEntries: Math.min(MAX_ARCHIVE_ENTRIES, Math.max(1, limits.maxEntries ?? MAX_ARCHIVE_ENTRIES)),
    maxExtractedBytes: limits.maxExtractedBytes,
  };
  if (!Number.isSafeInteger(normalizedLimits.maxExtractedBytes) || normalizedLimits.maxExtractedBytes <= 0) {
    throw new ToolchainError({ code: "TOOLCHAIN_EXTRACTION_FAILED", message: "Invalid extraction byte limit" });
  }
  fs.mkdirSync(destination, { recursive: true, mode: 0o700 });
  try {
    if (archive === "tar.gz") await extractTarGzip(archivePath, destination, normalizedLimits);
    else if (archive === "zip") await extractZip(archivePath, destination, normalizedLimits);
    else {
      throw new Error(`Unsupported safe archive format: ${archive}`);
    }
  } catch (error) {
    throw new ToolchainError({
      code: "TOOLCHAIN_EXTRACTION_FAILED",
      message: error instanceof Error ? error.message : "Managed runtime extraction failed",
      cause: error,
    });
  }
}
