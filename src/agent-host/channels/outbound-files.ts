import { realpath, stat } from "node:fs/promises";
import path from "node:path";
import { resolveLocalFileHref } from "../../shared/file-links";
import type { OutboundAttachment } from "./types";

const MAX_OUTBOUND_FILES = 4;
const MAX_OUTBOUND_BYTES = 20 * 1024 * 1024;
const MARKDOWN_LINK = /\[([^\]]*)\]\((?:<([^>]+)>|([^\s)]+))(?:\s+["'][^"']*["'])?\)/g;

const MIME_BY_EXTENSION: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ogg": "audio/ogg",
  ".mp3": "audio/mpeg",
  ".m4a": "audio/mp4",
  ".wav": "audio/wav",
  ".silk": "audio/silk",
  ".mp4": "video/mp4",
  ".pdf": "application/pdf",
  ".txt": "text/plain",
  ".md": "text/markdown",
  ".json": "application/json",
  ".zip": "application/zip",
};

function kindFromMime(mime: string | undefined): OutboundAttachment["kind"] {
  if (mime?.startsWith("image/")) return "image";
  if (mime?.startsWith("audio/")) return "voice";
  if (mime?.startsWith("video/")) return "video";
  return "file";
}

function isInside(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

export async function collectOutboundFiles(params: {
  finalText: string;
  cwd: string;
}): Promise<{ text: string; attachments: OutboundAttachment[] }> {
  const root = await realpath(params.cwd).catch(() => null);
  if (!root) return { text: params.finalText, attachments: [] };
  const candidates = [...params.finalText.matchAll(MARKDOWN_LINK)];
  const attachments: OutboundAttachment[] = [];
  const replacements = new Map<string, string>();
  const seen = new Set<string>();
  for (const match of candidates) {
    if (attachments.length >= MAX_OUTBOUND_FILES) break;
    const target = match[2] ?? match[3];
    const resolved = resolveLocalFileHref(target, params.cwd);
    if (!resolved) continue;
    const label = match[1].trim() || path.basename(resolved);
    replacements.set(match[0], `📎 ${label}（未发送）`);
    const canonical = await realpath(resolved).catch(() => null);
    if (!canonical || !isInside(canonical, root) || seen.has(canonical)) continue;
    const info = await stat(canonical).catch(() => null);
    if (!info?.isFile() || info.size <= 0 || info.size > MAX_OUTBOUND_BYTES) {
      continue;
    }
    seen.add(canonical);
    const name = path.basename(canonical);
    const mime = MIME_BY_EXTENSION[path.extname(name).toLowerCase()];
    attachments.push({
      kind: kindFromMime(mime),
      path: canonical,
      name,
      ...(mime ? { mime } : {}),
    });
    replacements.set(match[0], `📎 ${label || name}`);
  }
  let text = params.finalText;
  for (const [source, replacement] of replacements) text = text.replaceAll(source, replacement);
  return { text, attachments };
}
