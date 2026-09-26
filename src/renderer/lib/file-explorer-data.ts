import { encodeFilePathForApi, joinFilePath } from "./file-paths";
import type { GitStatusResult } from "@shared/api-types";

export type FileExplorerTranslate = (key: string, fallback: string) => string;
interface FileEntry {
  name: string;
  isDir: boolean;
  size: number;
  modified: string;
}
export interface FileNode {
  name: string;
  fullPath: string;
  isDir: boolean;
  size: number;
}
export interface DirectoryData {
  entries: FileNode[];
  gitStatus: GitStatusResult | null;
}

// Keep the compatibility transport until the file-domain migration in 22-05.
async function readEntries(path: string, t: FileExplorerTranslate): Promise<FileNode[]> {
  const response = await fetch(`/api/files/${encodeFilePathForApi(path)}?type=list`);
  if (!response.ok) {
    let message = t("fileListLoadFailedStatus", "Failed to load files (HTTP {status})").replace(
      "{status}",
      String(response.status),
    );
    try {
      const data = (await response.json()) as { error?: string };
      if (data.error) message = data.error;
    } catch {
      /* preserve the status fallback for non-JSON error bodies */
    }
    throw new Error(message);
  }
  const data = (await response.json()) as { entries?: FileEntry[] };
  return (data.entries ?? []).map((entry) => ({
    name: entry.name,
    fullPath: joinFilePath(path, entry.name),
    isDir: entry.isDir,
    size: entry.size,
  }));
}

export async function readDirectory(
  path: string,
  t: FileExplorerTranslate,
  includeGit: boolean,
): Promise<DirectoryData> {
  const [entries, statusResponse] = await Promise.all([
    readEntries(path, t),
    includeGit ? fetch(`/api/git-status?cwd=${encodeURIComponent(path)}`) : Promise.resolve(null),
  ]);
  const gitStatus = statusResponse?.ok ? ((await statusResponse.json()) as GitStatusResult) : null;
  return { entries, gitStatus };
}
