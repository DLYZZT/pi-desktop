// Media protocol adapted from Tencent's MIT-licensed openclaw-weixin transport.
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import type { DownloadedInboundAttachment, OutboundAttachment } from "../../types";
import { getWeixinUploadUrl, sendWeixinMediaMessage } from "./api";
import type { WeixinCdnMedia, WeixinMessage, WeixinMessageItem } from "./protocol-types";

export const WEIXIN_CDN_BASE_URL = "https://novac2c.cdn.weixin.qq.com/c2c";
const WEIXIN_MEDIA_MAX_BYTES = 20 * 1024 * 1024;

function buildDownloadUrl(media: WeixinCdnMedia): string {
  const value = media.full_url?.trim()
    ? media.full_url
    : media.encrypt_query_param
      ? `${WEIXIN_CDN_BASE_URL}/download?encrypted_query_param=${encodeURIComponent(media.encrypt_query_param)}`
      : "";
  if (!value) throw new Error("微信附件缺少下载地址");
  const url = new URL(value);
  const allowedHost =
    url.hostname === new URL(WEIXIN_CDN_BASE_URL).hostname ||
    url.hostname.endsWith(".weixin.qq.com") ||
    url.hostname.endsWith(".qq.com");
  if (url.protocol !== "https:" || !allowedHost) throw new Error("微信附件下载地址不受信任");
  return url.toString();
}

async function fetchLimited(url: string, maxBytes = WEIXIN_MEDIA_MAX_BYTES): Promise<Buffer> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20_000);
  try {
    const response = await fetch(url, { signal: controller.signal, redirect: "error" });
    if (!response.ok) throw new Error(`微信附件下载失败 (${response.status})`);
    const declared = Number(response.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > maxBytes + 16) throw new Error("微信附件超过 20 MiB 限制");
    if (!response.body) throw new Error("微信附件内容为空");
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes + 16) {
        await reader.cancel().catch(() => undefined);
        throw new Error("微信附件超过 20 MiB 限制");
      }
      chunks.push(value);
    }
    return Buffer.concat(
      chunks.map((chunk) => Buffer.from(chunk)),
      total,
    );
  } finally {
    clearTimeout(timer);
  }
}

function parseAesKey(value: string): Buffer {
  const decoded = Buffer.from(value, "base64");
  if (decoded.length === 16) return decoded;
  if (decoded.length === 32 && /^[0-9a-f]{32}$/i.test(decoded.toString("ascii"))) {
    return Buffer.from(decoded.toString("ascii"), "hex");
  }
  throw new Error("微信附件加密信息无效");
}

async function downloadMedia(media: WeixinCdnMedia, imageHexKey?: string): Promise<Buffer> {
  const encrypted = await fetchLimited(buildDownloadUrl(media));
  const encodedKey = imageHexKey ? Buffer.from(imageHexKey, "hex").toString("base64") : media.aes_key;
  if (!encodedKey) return encrypted;
  const decipher = createDecipheriv("aes-128-ecb", parseAesKey(encodedKey), null);
  const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);
  if (decrypted.length > WEIXIN_MEDIA_MAX_BYTES) throw new Error("微信附件超过 20 MiB 限制");
  return decrypted;
}

function mimeFromName(name: string | undefined): string | undefined {
  const extension = path.extname(name ?? "").toLowerCase();
  return (
    {
      ".txt": "text/plain",
      ".md": "text/markdown",
      ".json": "application/json",
      ".pdf": "application/pdf",
      ".zip": "application/zip",
      ".doc": "application/msword",
      ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      ".xls": "application/vnd.ms-excel",
      ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      ".mp3": "audio/mpeg",
      ".wav": "audio/wav",
      ".ogg": "audio/ogg",
    } as Record<string, string>
  )[extension];
}

function pcmToWav(pcm: Uint8Array, sampleRate = 24_000): Buffer {
  const wav = Buffer.allocUnsafe(44 + pcm.byteLength);
  wav.write("RIFF", 0);
  wav.writeUInt32LE(36 + pcm.byteLength, 4);
  wav.write("WAVEfmt ", 8);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(sampleRate, 24);
  wav.writeUInt32LE(sampleRate * 2, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write("data", 36);
  wav.writeUInt32LE(pcm.byteLength, 40);
  Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength).copy(wav, 44);
  return wav;
}

async function decodeSilk(data: Buffer): Promise<Buffer | null> {
  try {
    const { decode, isSilk } = await import("silk-wasm");
    if (!isSilk(data)) return null;
    const decoded = await decode(data, 24_000);
    return pcmToWav(decoded.data, 24_000);
  } catch {
    if (data.subarray(0, 7).toString("ascii").includes("#!SILK")) {
      console.warn("[pi-desktop] Failed to decode a Weixin SILK voice attachment; preserving the original audio");
    }
    return null;
  }
}

function originalVoiceAttachment(data: Buffer): DownloadedInboundAttachment {
  const signature = data.subarray(0, 12).toString("ascii");
  if (signature.startsWith("RIFF") && signature.slice(8) === "WAVE") {
    return { kind: "voice", data, name: "voice.wav", mime: "audio/wav" };
  }
  if (signature.startsWith("OggS")) {
    return { kind: "voice", data, name: "voice.ogg", mime: "audio/ogg" };
  }
  if (signature.startsWith("ID3") || (data[0] === 0xff && (data[1] & 0xe0) === 0xe0)) {
    return { kind: "voice", data, name: "voice.mp3", mime: "audio/mpeg" };
  }
  if (signature.slice(4, 8) === "ftyp") {
    return { kind: "voice", data, name: "voice.m4a", mime: "audio/mp4" };
  }
  if (data.subarray(0, 7).toString("ascii").includes("#!SILK")) {
    return { kind: "voice", data, name: "voice.silk", mime: "audio/silk" };
  }
  return { kind: "voice", data, name: "voice.bin", mime: "application/octet-stream" };
}

export async function downloadWeixinAttachments(message: WeixinMessage): Promise<DownloadedInboundAttachment[]> {
  const result: DownloadedInboundAttachment[] = [];
  for (const item of message.item_list ?? []) {
    if (item.type === 2 && item.image_item?.media) {
      result.push({
        kind: "image",
        data: await downloadMedia(item.image_item.media, item.image_item.aeskey),
      });
    } else if (item.type === 3 && item.voice_item?.media) {
      // Weixin already supplies the user's spoken words in `text` when speech
      // recognition succeeds. Passing the same audio path as well encourages
      // agents to transcribe it again instead of answering the available text.
      if (item.voice_item.text?.trim()) continue;
      const raw = await downloadMedia(item.voice_item.media);
      const wav = await decodeSilk(raw);
      result.push(
        wav ? { kind: "voice", data: wav, name: "voice.wav", mime: "audio/wav" } : originalVoiceAttachment(raw),
      );
    } else if (item.type === 4 && item.file_item?.media) {
      const name = item.file_item.file_name || "attachment.bin";
      result.push({
        kind: "file",
        data: await downloadMedia(item.file_item.media),
        name,
        ...(mimeFromName(name) ? { mime: mimeFromName(name) } : {}),
      });
    }
  }
  return result;
}

function encryptAesEcb(data: Buffer, key: Buffer): Buffer {
  const cipher = createCipheriv("aes-128-ecb", key, null);
  return Buffer.concat([cipher.update(data), cipher.final()]);
}

function trustedUploadUrl(value: string): string {
  const url = new URL(value);
  const allowedHost =
    url.hostname === new URL(WEIXIN_CDN_BASE_URL).hostname ||
    url.hostname.endsWith(".weixin.qq.com") ||
    url.hostname.endsWith(".qq.com");
  if (url.protocol !== "https:" || !allowedHost) throw new Error("微信附件上传地址不受信任");
  return url.toString();
}

export async function sendWeixinAttachment(params: {
  baseUrl: string;
  token: string;
  to: string;
  attachment: OutboundAttachment;
  contextToken?: string;
  runId?: string;
  clientId: string;
}): Promise<void> {
  const info = await stat(params.attachment.path);
  if (!info.isFile() || info.size <= 0) throw new Error("微信出站附件不是有效文件");
  if (info.size > WEIXIN_MEDIA_MAX_BYTES) throw new Error("微信出站附件超过 20 MiB 限制");
  const data = await readFile(params.attachment.path);
  const key = randomBytes(16);
  const encrypted = encryptAesEcb(data, key);
  const filekey = randomBytes(16).toString("hex");
  const mediaType = params.attachment.kind === "image" ? 1 : 3;
  const upload = await getWeixinUploadUrl({
    baseUrl: params.baseUrl,
    token: params.token,
    filekey,
    mediaType,
    to: params.to,
    rawSize: data.length,
    rawMd5: createHash("md5").update(data).digest("hex"),
    encryptedSize: encrypted.length,
    aesKeyHex: key.toString("hex"),
  });
  const uploadUrl = upload.upload_full_url?.trim()
    ? trustedUploadUrl(upload.upload_full_url)
    : upload.upload_param
      ? `${WEIXIN_CDN_BASE_URL}/upload?encrypted_query_param=${encodeURIComponent(upload.upload_param)}&filekey=${encodeURIComponent(filekey)}`
      : "";
  if (!uploadUrl) throw new Error("微信未返回附件上传地址");
  const response = await fetch(uploadUrl, {
    method: "POST",
    redirect: "error",
    headers: { "Content-Type": "application/octet-stream" },
    body: new Uint8Array(encrypted),
  });
  if (!response.ok) throw new Error(`微信附件上传失败 (${response.status})`);
  const downloadParam = response.headers.get("x-encrypted-param");
  if (!downloadParam) throw new Error("微信附件上传响应缺少下载参数");
  const media = {
    encrypt_query_param: downloadParam,
    aes_key: Buffer.from(key.toString("hex")).toString("base64"),
    encrypt_type: 1,
  };
  const item: WeixinMessageItem =
    params.attachment.kind === "image"
      ? { type: 2, image_item: { media, mid_size: encrypted.length } }
      : {
          type: 4,
          file_item: {
            media,
            file_name: params.attachment.name || path.basename(params.attachment.path),
            len: String(data.length),
          },
        };
  await sendWeixinMediaMessage({
    baseUrl: params.baseUrl,
    token: params.token,
    to: params.to,
    item,
    contextToken: params.contextToken,
    runId: params.runId,
    clientId: params.clientId,
  });
}
