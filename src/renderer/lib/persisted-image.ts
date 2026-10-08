import type { ImageContent } from "./types";

/** Display saved raster bytes only; text paths and remote URLs are not attachments. */
export function persistedImageSource(block: ImageContent): string | undefined {
  if (block.deferredContent) return;
  const flat = block as unknown as { data?: string; mimeType?: string };
  const data = block.source ? (block.source.type === "base64" ? block.source.data : undefined) : flat.data;
  const mimeType = block.source ? block.source.media_type : flat.mimeType;
  return typeof data === "string" && data && /^image\/(?:png|jpeg|gif|webp)$/.test(mimeType ?? "")
    ? `data:${mimeType};base64,${data}`
    : undefined;
}
