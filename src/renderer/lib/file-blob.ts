/**
 * ISSUE-004: load file bytes via RPC/fetch shim and produce Blob URLs
 * (img/audio/iframe cannot hit /api without going through fetch).
 */
import { call } from "./api-client";

export type FileReadResult = {
  content: string;
  encoding?: "utf8" | "base64" | "too_large";
  mime?: string;
  language?: string;
  size?: number;
  truncated?: boolean;
  error?: string;
};

export async function readFilePayload(
  filePath: string,
  sourceSessionId?: string | null,
): Promise<FileReadResult> {
  return call("files.read", {
    path: filePath,
    sourceSessionId: sourceSessionId ?? undefined,
  }) as Promise<FileReadResult>;
}

export function base64ToBlob(base64: string, mime: string): Blob {
  const binary = atob(base64);
  const len = binary.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], { type: mime || "application/octet-stream" });
}

export async function fileToObjectUrl(
  filePath: string,
  sourceSessionId?: string | null,
): Promise<{ url: string; mime: string; size: number; revoke: () => void }> {
  const data = await readFilePayload(filePath, sourceSessionId);
  if (data.encoding === "too_large") {
    throw new Error("File too large for preview");
  }
  if (data.encoding === "base64" && data.content) {
    const mime = data.mime || "application/octet-stream";
    const blob = base64ToBlob(data.content, mime);
    const url = URL.createObjectURL(blob);
    return {
      url,
      mime,
      size: data.size ?? blob.size,
      revoke: () => URL.revokeObjectURL(url),
    };
  }
  // Text payload
  const blob = new Blob([data.content ?? ""], {
    type: data.mime || "text/plain;charset=utf-8",
  });
  const url = URL.createObjectURL(blob);
  return {
    url,
    mime: data.mime || "text/plain",
    size: data.size ?? blob.size,
    revoke: () => URL.revokeObjectURL(url),
  };
}

export async function downloadFileViaRpc(
  filePath: string,
  fileName: string,
  sourceSessionId?: string | null,
): Promise<void> {
  const data = await call("files.download", {
    path: filePath,
    sourceSessionId: sourceSessionId ?? undefined,
  });
  const blob = base64ToBlob(data.base64, data.mime);

  // Native binary save preserves exact bytes for text and arbitrary binary files.
  if (window.piBridge?.saveBinaryFile) {
    const saved = await window.piBridge.saveBinaryFile({
      base64: data.base64,
      defaultPath: fileName,
    });
    if (saved) {
      await window.piBridge.showItemInFolder(saved);
      return;
    }
  }

  const url = URL.createObjectURL(blob);
  try {
    const a = document.createElement("a");
    a.href = url;
    a.download = fileName;
    a.rel = "noopener";
    document.body.appendChild(a);
    a.click();
    a.remove();
  } finally {
    URL.revokeObjectURL(url);
  }
}
