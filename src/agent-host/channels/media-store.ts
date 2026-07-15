import { createHash, randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, readdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { allowFileRoot, invalidateAllowedRootsCache } from "../file-access";
import type { DownloadedInboundAttachment, StagedInboundAttachment } from "./types";

export const CHANNEL_MEDIA_MAX_ATTACHMENTS = 4;
export const CHANNEL_MEDIA_MAX_BYTES = 20 * 1024 * 1024;
export const CHANNEL_MEDIA_TTL_MS = 24 * 60 * 60 * 1_000;

const MIME_EXTENSIONS: Record<string, string> = {
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/gif": ".gif",
  "image/webp": ".webp",
  "audio/ogg": ".ogg",
  "audio/mpeg": ".mp3",
  "audio/mp4": ".m4a",
  "audio/wav": ".wav",
  "audio/silk": ".silk",
  "text/plain": ".txt",
  "application/pdf": ".pdf",
  "application/json": ".json",
  "application/zip": ".zip",
};

function stableSegment(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 24);
}

function safeName(name: string | undefined): string | undefined {
  if (!name) return undefined;
  const base = path
    .basename(name.replace(/\\/g, "/"))
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .trim();
  return base ? [...base].slice(0, 160).join("") : undefined;
}

function sniffImageMime(data: Buffer): string | undefined {
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return "image/jpeg";
  if (data.length >= 8 && data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
    return "image/png";
  }
  if (data.length >= 6 && ["GIF87a", "GIF89a"].includes(data.subarray(0, 6).toString("ascii"))) return "image/gif";
  if (
    data.length >= 12 &&
    data.subarray(0, 4).toString("ascii") === "RIFF" &&
    data.subarray(8, 12).toString("ascii") === "WEBP"
  ) {
    return "image/webp";
  }
  return undefined;
}

function normalizedMime(attachment: DownloadedInboundAttachment): string | undefined {
  if (attachment.kind === "image") {
    const detected = sniffImageMime(attachment.data);
    if (!detected) throw new Error("附件图片格式无效或不受支持");
    return detected;
  }
  const mime = attachment.mime?.split(";", 1)[0]?.trim().toLowerCase();
  return mime && /^[a-z0-9][a-z0-9.+-]*\/[a-z0-9][a-z0-9.+-]*$/.test(mime) ? mime : undefined;
}

function safeExtension(name: string | undefined, mime: string | undefined): string {
  const fromMime = mime ? MIME_EXTENSIONS[mime] : undefined;
  if (fromMime) return fromMime;
  const candidate = name ? path.extname(name).toLowerCase() : "";
  return /^\.[a-z0-9]{1,10}$/.test(candidate) ? candidate : ".bin";
}

export class ChannelMediaStore {
  constructor(private readonly root: string) {}

  async initialize(): Promise<void> {
    await this.ensureDirectory(this.root);
    allowFileRoot(this.root);
    invalidateAllowedRootsCache();
    await this.cleanupExpired();
  }

  private async ensureDirectory(directory: string): Promise<void> {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const info = await lstat(directory);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("媒体暂存目录不是安全的本地目录");
    await chmod(directory, 0o700).catch(() => undefined);
  }

  async stage(
    accountId: string,
    envelopeId: string,
    attachments: DownloadedInboundAttachment[],
  ): Promise<StagedInboundAttachment[]> {
    if (attachments.length > CHANNEL_MEDIA_MAX_ATTACHMENTS) {
      throw new Error(`单条消息最多支持 ${CHANNEL_MEDIA_MAX_ATTACHMENTS} 个附件`);
    }
    if (attachments.length === 0) return [];
    const accountDirectory = path.join(this.root, stableSegment(accountId));
    const directory = path.join(accountDirectory, stableSegment(envelopeId));
    await this.ensureDirectory(this.root);
    await this.ensureDirectory(accountDirectory);
    await this.ensureDirectory(directory);
    const staged: StagedInboundAttachment[] = [];
    try {
      for (const attachment of attachments) {
        if (attachment.data.length === 0) throw new Error("附件内容为空");
        if (attachment.data.length > CHANNEL_MEDIA_MAX_BYTES) {
          throw new Error(`单个附件不能超过 ${CHANNEL_MEDIA_MAX_BYTES / 1024 / 1024} MiB`);
        }
        const name = safeName(attachment.name);
        const mime = normalizedMime(attachment);
        const filePath = path.join(directory, `${randomUUID()}${safeExtension(name, mime)}`);
        await writeFile(filePath, attachment.data, { flag: "wx", mode: 0o600 });
        staged.push({
          kind: attachment.kind,
          path: filePath,
          size: attachment.data.length,
          ...(name ? { name } : {}),
          ...(mime ? { mime } : {}),
        });
      }
      return staged;
    } catch (error) {
      await rm(directory, { recursive: true, force: true }).catch(() => undefined);
      throw error;
    }
  }

  async cleanupExpired(now = Date.now()): Promise<void> {
    const accounts = await readdir(this.root, { withFileTypes: true }).catch(() => []);
    for (const account of accounts) {
      if (!account.isDirectory()) continue;
      const accountPath = path.join(this.root, account.name);
      const events = await readdir(accountPath, { withFileTypes: true }).catch(() => []);
      for (const event of events) {
        if (!event.isDirectory()) continue;
        const eventPath = path.join(accountPath, event.name);
        const info = await stat(eventPath).catch(() => null);
        if (info && now - info.mtimeMs > CHANNEL_MEDIA_TTL_MS) {
          await rm(eventPath, { recursive: true, force: true });
        }
      }
    }
  }
}
