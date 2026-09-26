import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import type { ApiHandler } from "../../contract/rpc";
import { RpcError } from "../../contract/types";
import {
  DOCX_PREVIEW_MAX_BYTES,
  FILE_DOWNLOAD_MAX_BYTES,
  IMAGE_PREVIEW_MAX_BYTES,
  TEXT_PREVIEW_MAX_BYTES,
  documentPreviewKind,
  getAudioMime,
  getDocumentMime,
  getImageMime,
} from "../../shared/file-types";
import { assertPathAllowed } from "../path-authorization";
import { readTextPreview } from "../text-preview";
import { FileSuggestionRequestError, fileSuggestionService } from "../file-suggestions";
import type { createFileWatchService } from "../file-watch";

const IGNORED_NAMES = new Set([
  "node_modules",
  ".git",
  ".next",
  "dist",
  "build",
  "__pycache__",
  ".turbo",
  ".cache",
  "coverage",
  ".pytest_cache",
  ".mypy_cache",
  "target",
  "vendor",
  ".DS_Store",
]);

function fileWatchLeaseKey(filePath: string, watchId?: string): string {
  if (typeof filePath !== "string" || !filePath)
    throw new RpcError({ code: "BAD_REQUEST", message: "Watch path is required" });
  // Keep path-only leases for existing callers until the compatibility adapter
  // is retired. Identified consumers cannot replace or stop those leases.
  if (watchId === undefined) return `files.watch:${filePath}`;
  if (typeof watchId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(watchId)) {
    throw new RpcError({ code: "BAD_REQUEST", message: "Invalid file watch ID" });
  }
  return `files.watch.id:${watchId}:${filePath}`;
}

const EXT_TO_LANGUAGE: Record<string, string> = {
  ts: "typescript",
  tsx: "typescript",
  js: "javascript",
  jsx: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  py: "python",
  rb: "ruby",
  go: "go",
  rs: "rust",
  java: "java",
  kt: "kotlin",
  swift: "swift",
  c: "c",
  cpp: "cpp",
  h: "c",
  hpp: "cpp",
  cs: "csharp",
  html: "html",
  htm: "html",
  css: "css",
  scss: "css",
  less: "css",
  json: "json",
  jsonl: "json",
  yaml: "yaml",
  yml: "yaml",
  toml: "toml",
  xml: "xml",
  md: "markdown",
  mdx: "markdown",
  sh: "bash",
  bash: "bash",
  zsh: "bash",
  fish: "bash",
  sql: "sql",
  txt: "text",
};

function getLanguage(filePath: string): string {
  const base = path.basename(filePath).toLowerCase();
  if (base === "dockerfile" || base.startsWith("dockerfile.")) return "dockerfile";
  if (base === ".env" || base.startsWith(".env.")) return "bash";
  if (base === "makefile" || base === "gnumakefile") return "makefile";
  const ext = base.split(".").pop() ?? "";
  return EXT_TO_LANGUAGE[ext] ?? "text";
}

type FileHandlers = {
  list: NonNullable<ApiHandler["files.list"]>;
  read: NonNullable<ApiHandler["files.read"]>;
  download: NonNullable<ApiHandler["files.download"]>;
  meta: NonNullable<ApiHandler["files.meta"]>;
  preview: NonNullable<ApiHandler["files.preview"]>;
  index: NonNullable<ApiHandler["files.index"]>;
  startWatch: NonNullable<ApiHandler["files.watchStart"]>;
  stopWatch: NonNullable<ApiHandler["files.watchStop"]>;
};

export function createFileHandlers(fileWatch: Pick<ReturnType<typeof createFileWatchService>, "start" | "stop">) {
  return {
    list: async (params) => {
      const { path: dirPath } = params as { path: string };
      await assertPathAllowed(dirPath);
      if (!existsSync(dirPath) || !statSync(dirPath).isDirectory()) {
        throw new RpcError({ code: "NOT_FOUND", message: "Directory not found" });
      }
      const names = readdirSync(dirPath);
      const entries: Array<{
        name: string;
        isDir: boolean;
        size?: number;
        mtime?: number;
        path: string;
        type: "file" | "directory";
      }> = [];
      for (const name of names) {
        if (IGNORED_NAMES.has(name)) continue;
        const full = path.join(dirPath, name);
        try {
          const st = statSync(full);
          const isDir = st.isDirectory();
          entries.push({
            name,
            path: full,
            isDir,
            type: isDir ? "directory" : "file",
            size: st.size,
            mtime: st.mtimeMs,
          });
        } catch {
          /* skip unreadable */
        }
      }
      entries.sort((a, b) => {
        if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
        return a.name.localeCompare(b.name);
      });
      return { entries: entries as never };
    },

    read: async (params) => {
      const { path: filePath, sourceSessionId } = params as {
        path: string;
        sourceSessionId?: string;
      };
      await assertPathAllowed(filePath, sourceSessionId);
      const st = statSync(filePath);
      if (!st.isFile()) {
        throw new RpcError({ code: "BAD_REQUEST", message: "Not a file" });
      }

      const imageMime = getImageMime(filePath);
      const audioMime = getAudioMime(filePath);
      const documentMime = getDocumentMime(filePath);
      const binaryMime = imageMime || audioMime || documentMime;

      // ISSUE-004: binary as base64+mime; never UTF-8 corrupt
      if (binaryMime) {
        const limit = imageMime ? IMAGE_PREVIEW_MAX_BYTES : documentMime ? DOCX_PREVIEW_MAX_BYTES : 50 * 1024 * 1024;
        if (st.size > limit) {
          return {
            content: "",
            encoding: "too_large" as const,
            mime: binaryMime,
            language: getLanguage(filePath),
            size: st.size,
            truncated: true,
          };
        }
        return {
          content: readFileSync(filePath).toString("base64"),
          encoding: "base64" as const,
          mime: binaryMime,
          language: getLanguage(filePath),
          size: st.size,
          truncated: false,
        };
      }

      const preview = await readTextPreview(filePath, TEXT_PREVIEW_MAX_BYTES);
      return { ...preview, encoding: "utf8" as const, language: getLanguage(filePath) };
    },

    download: async (params) => {
      const { path: filePath, sourceSessionId } = params as {
        path: string;
        sourceSessionId?: string;
      };
      await assertPathAllowed(filePath, sourceSessionId);
      const st = statSync(filePath);
      if (!st.isFile()) {
        throw new RpcError({ code: "BAD_REQUEST", message: "Not a file" });
      }
      if (st.size > FILE_DOWNLOAD_MAX_BYTES) {
        throw new RpcError({
          code: "RESULT_TOO_LARGE",
          message: `File exceeds the ${FILE_DOWNLOAD_MAX_BYTES / 1024 / 1024} MiB download limit`,
          detail: { size: st.size, maxBytes: FILE_DOWNLOAD_MAX_BYTES },
        });
      }
      return {
        base64: readFileSync(filePath).toString("base64"),
        size: st.size,
        mime:
          getImageMime(filePath) || getAudioMime(filePath) || getDocumentMime(filePath) || "application/octet-stream",
      };
    },

    meta: async (params) => {
      const { path: filePath, sourceSessionId } = params as {
        path: string;
        sourceSessionId?: string;
      };
      await assertPathAllowed(filePath, sourceSessionId);
      const st = statSync(filePath);
      const imageMime = getImageMime(filePath);
      const audioMime = getAudioMime(filePath);
      const documentMime = getDocumentMime(filePath);
      return {
        size: st.size,
        mtime: st.mtimeMs,
        language: getLanguage(filePath),
        kind: documentPreviewKind(filePath) ?? (imageMime ? "image" : "file"),
        mime: imageMime ?? audioMime ?? documentMime ?? "text/plain",
      };
    },

    preview: async (params) => {
      const { path: filePath, sourceSessionId } = params as {
        path: string;
        sourceSessionId?: string;
      };
      await assertPathAllowed(filePath, sourceSessionId);
      const st = statSync(filePath);
      if (!st.isFile()) throw new RpcError({ code: "BAD_REQUEST", message: "Not a file" });
      const imgMime = getImageMime(filePath);
      if (imgMime) {
        if (st.size > IMAGE_PREVIEW_MAX_BYTES) {
          return { kind: "too_large", mime: imgMime, size: st.size };
        }
        return {
          kind: "image",
          mime: imgMime,
          base64: readFileSync(filePath).toString("base64"),
        };
      }
      const docKind = documentPreviewKind(filePath);
      if (docKind === "docx") {
        if (st.size > DOCX_PREVIEW_MAX_BYTES) {
          return { kind: "too_large", mime: getDocumentMime(filePath) ?? undefined, size: st.size };
        }
        return {
          kind: "docx",
          mime: getDocumentMime(filePath) ?? undefined,
          base64: readFileSync(filePath).toString("base64"),
        };
      }
      const preview = await readTextPreview(filePath, TEXT_PREVIEW_MAX_BYTES);
      return {
        kind: "text",
        content: preview.content,
        language: getLanguage(filePath),
        ...(preview.truncated ? { truncated: true } : {}),
      };
    },

    index: async (params) => {
      const { root, query } = params as { root: string; query?: string };
      await assertPathAllowed(root);
      try {
        return await fileSuggestionService.suggest(root, query);
      } catch (error) {
        if (error instanceof FileSuggestionRequestError) {
          throw new RpcError({ code: "BAD_REQUEST", message: error.message });
        }
        throw error;
      }
    },

    startWatch: async (params, context) => {
      const { path: filePath, sourceSessionId, watchId } = params;
      const leaseKey = fileWatchLeaseKey(filePath, watchId);
      if (watchId !== undefined && !context)
        throw new RpcError({ code: "BAD_REQUEST", message: "Watch IDs require an RPC context" });
      let released = false;
      let acquired: (() => void) | undefined;
      const release = () => {
        if (released) return;
        released = true;
        acquired?.();
        acquired = undefined;
      };
      // Reserve before authorization/installation can suspend. A stop or port
      // close can now retire this exact pending acquisition as well.
      context?.setLease(leaseKey, release);
      try {
        if (released) return { ok: true as const };
        const stop = await fileWatch.start(filePath, sourceSessionId);
        if (released) stop();
        else acquired = stop;
        return { ok: true as const };
      } catch (error) {
        if (!released) {
          if (context) context.releaseLease(leaseKey);
          else release();
        }
        throw error;
      }
    },

    stopWatch: async (params, context) => {
      const { path: filePath, watchId } = params;
      const leaseKey = fileWatchLeaseKey(filePath, watchId);
      if (watchId !== undefined && !context)
        throw new RpcError({ code: "BAD_REQUEST", message: "Watch IDs require an RPC context" });
      if (context) context.releaseLease(leaseKey);
      else fileWatch.stop(filePath);
      return { ok: true as const };
    },
  } satisfies FileHandlers;
}
