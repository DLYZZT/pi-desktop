import { joinFilePath } from "./file-paths";
import { call } from "./api-client";
import type { GitStatusResult } from "@shared/api-types";

export type FileExplorerTranslate = (key: string, fallback: string) => string;
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

async function readEntries(path: string, t: FileExplorerTranslate): Promise<FileNode[]> {
  try {
    const { entries } = await call("files.list", { path });
    return entries.map((entry) => ({
      name: entry.name,
      fullPath: joinFilePath(path, entry.name),
      isDir: entry.isDir,
      size: entry.size,
    }));
  } catch (error) {
    throw new Error(
      error instanceof Error && error.message ? error.message : t("fileListLoadFailed", "Failed to load files"),
    );
  }
}

export async function readDirectory(
  path: string,
  t: FileExplorerTranslate,
  includeGit: boolean,
): Promise<DirectoryData> {
  const [entries, gitStatus] = await Promise.all([
    readEntries(path, t),
    includeGit ? call("git.status", { path }).catch(() => null) : Promise.resolve(null),
  ]);
  return { entries, gitStatus };
}
