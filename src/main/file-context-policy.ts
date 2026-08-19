import { realpath, stat } from "node:fs/promises";
import path from "node:path";
import type {
  FileContextMenuErrorCode,
  InspectLocalFilesRequest,
  LocalFileInspection,
  ShowFileContextMenuRequest,
} from "../contract/desktop";
import { fileUrlToLocalPath } from "../shared/file-url.ts";

export const MAX_CONTEXT_TEXT_FILE_BYTES = 1_000_000;
export const MAX_LOCAL_FILE_INSPECTIONS = 8;

export interface ValidatedFileContextTarget {
  path: string;
  cwd: string | null;
  insideCwd: boolean;
  isFile: boolean;
  isDirectory: boolean;
  size: number;
  allowCopyContents: boolean;
}

export type FileContextValidationResult =
  { ok: true; target: ValidatedFileContextTarget } | { ok: false; code: FileContextMenuErrorCode };

function allowedSource(value: unknown): value is ShowFileContextMenuRequest["source"] {
  return value === "local-file-reference" || value === "rendered-agent-text";
}

function requestPath(href: string): string | null {
  if (href.includes("\0") || href.length > 32_768) return null;
  if (/^file:/i.test(href)) return fileUrlToLocalPath(href);
  return path.isAbsolute(href) ? path.normalize(href) : null;
}

function pathIsWithin(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

async function realDirectory(value: string | undefined): Promise<string | null> {
  if (!value || !path.isAbsolute(value) || value.includes("\0")) return null;
  try {
    const resolved = await realpath(value);
    return (await stat(resolved)).isDirectory() ? resolved : null;
  } catch {
    return null;
  }
}

export async function validateFileContextRequestResult(request: unknown): Promise<FileContextValidationResult> {
  if (!request || typeof request !== "object") return { ok: false, code: "INVALID_REQUEST" };
  const candidate = request as Partial<ShowFileContextMenuRequest>;
  if (
    typeof candidate.href !== "string" ||
    !allowedSource(candidate.source) ||
    (candidate.cwd !== undefined && typeof candidate.cwd !== "string") ||
    (candidate.language !== undefined && candidate.language !== "en-US" && candidate.language !== "zh-CN")
  ) {
    return { ok: false, code: "INVALID_REQUEST" };
  }
  const unresolvedPath = requestPath(candidate.href);
  if (!unresolvedPath) return { ok: false, code: "INVALID_REQUEST" };
  const cwd = await realDirectory(candidate.cwd);
  if (candidate.cwd !== undefined && !cwd) return { ok: false, code: "INVALID_REQUEST" };
  let resolvedPath: string;
  try {
    resolvedPath = await realpath(unresolvedPath);
  } catch {
    return { ok: false, code: "NOT_FOUND" };
  }
  try {
    const metadata = await stat(resolvedPath);
    if (!metadata.isFile() && !metadata.isDirectory()) return { ok: false, code: "NOT_A_FILE_OR_DIRECTORY" };
    const insideCwd = cwd ? pathIsWithin(resolvedPath, cwd) : false;
    return {
      ok: true,
      target: {
        path: resolvedPath,
        cwd,
        insideCwd,
        isFile: metadata.isFile(),
        isDirectory: metadata.isDirectory(),
        size: metadata.size,
        allowCopyContents: insideCwd && metadata.isFile() && metadata.size <= MAX_CONTEXT_TEXT_FILE_BYTES,
      },
    };
  } catch {
    return { ok: false, code: "NOT_FOUND" };
  }
}

export async function validateFileContextRequest(request: unknown): Promise<ValidatedFileContextTarget | null> {
  const result = await validateFileContextRequestResult(request);
  return result.ok ? result.target : null;
}

export async function inspectLocalFiles(request: unknown): Promise<LocalFileInspection[]> {
  if (!request || typeof request !== "object") return [];
  const candidate = request as Partial<InspectLocalFilesRequest>;
  if (!Array.isArray(candidate.paths) || candidate.paths.length > MAX_LOCAL_FILE_INSPECTIONS) return [];
  const cwd = await realDirectory(candidate.cwd);
  return Promise.all(
    candidate.paths.map(async (requestedPath): Promise<LocalFileInspection> => {
      if (typeof requestedPath !== "string" || !path.isAbsolute(requestedPath) || requestedPath.includes("\0")) {
        return {
          path: typeof requestedPath === "string" ? requestedPath : "",
          exists: false,
          isFile: false,
          insideCwd: false,
        };
      }
      try {
        const resolvedPath = await realpath(requestedPath);
        const metadata = await stat(resolvedPath);
        return {
          path: resolvedPath,
          exists: true,
          isFile: metadata.isFile(),
          insideCwd: cwd ? pathIsWithin(resolvedPath, cwd) : false,
        };
      } catch {
        return { path: requestedPath, exists: false, isFile: false, insideCwd: false };
      }
    }),
  );
}
