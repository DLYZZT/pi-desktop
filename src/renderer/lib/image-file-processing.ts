import { decodedBase64ByteLength } from "../../shared/draft-store.ts";

export interface ProcessedImageFile {
  data: string;
  mimeType: string;
  previewUrl: string;
}

export interface ImageFileFailure {
  file: File;
  error: unknown;
}

export const DRAFT_IMAGE_MAX_DIMENSION = 2048;
export const DRAFT_IMAGE_TARGET_BYTES = 512 * 1024;

interface ImageFileProcessingDependencies {
  readAsDataUrl: (file: File) => Promise<string>;
  createObjectUrl: (file: File) => string;
  revokeObjectUrl: (url: string) => void;
  compressImage?: (image: { data: string; mimeType: string }) => Promise<{ data: string; mimeType: string }>;
}

const browserDependencies: ImageFileProcessingDependencies = {
  readAsDataUrl(file) {
    return new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result ?? ""));
      reader.onerror = () => reject(reader.error ?? new Error("Failed to read image"));
      reader.onabort = () => reject(new Error("Image read was cancelled"));
      reader.readAsDataURL(file);
    });
  },
  createObjectUrl: (file) => URL.createObjectURL(file),
  revokeObjectUrl: (url) => URL.revokeObjectURL(url),
  compressImage: compressDraftImage,
};

function base64ToBytes(data: string): Uint8Array {
  if (typeof atob === "function") {
    const binary = atob(data);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return bytes;
  }
  return Uint8Array.from(Buffer.from(data, "base64"));
}

function isAnimatedOrVector(mimeType: string): boolean {
  const mime = mimeType.toLowerCase();
  return mime.includes("gif") || mime.includes("svg") || mime.includes("xml");
}

async function blobToBase64(blob: Blob): Promise<string> {
  const buffer = await blob.arrayBuffer();
  if (typeof FileReader !== "function") return Buffer.from(buffer).toString("base64");
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result ?? "");
      const separator = result.indexOf(",");
      resolve(separator >= 0 ? result.slice(separator + 1) : result);
    };
    reader.onerror = () => reject(reader.error ?? new Error("Failed to encode compressed image"));
    reader.readAsDataURL(blob);
  });
}

type Draft2DContext = Pick<CanvasRenderingContext2D, "fillStyle" | "fillRect" | "drawImage">;

function createDraftCanvas(width: number, height: number): OffscreenCanvas | HTMLCanvasElement | null {
  if (typeof OffscreenCanvas === "function") return new OffscreenCanvas(width, height);
  if (typeof document === "undefined" || typeof document.createElement !== "function") return null;
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  return canvas;
}

function getDraft2dContext(canvas: OffscreenCanvas | HTMLCanvasElement): Draft2DContext | null {
  const ctx = canvas.getContext("2d");
  if (!ctx || !("drawImage" in ctx) || !("fillRect" in ctx) || !("fillStyle" in ctx)) return null;
  return ctx;
}

async function canvasToBlob(
  canvas: OffscreenCanvas | HTMLCanvasElement,
  mimeType: string,
  quality: number,
): Promise<Blob | null> {
  if ("convertToBlob" in canvas && typeof canvas.convertToBlob === "function") {
    return canvas.convertToBlob({ type: mimeType, quality });
  }
  if (!("toBlob" in canvas) || typeof canvas.toBlob !== "function") return null;
  return new Promise((resolve) => {
    canvas.toBlob((blob) => resolve(blob), mimeType, quality);
  });
}

/**
 * Downscale and JPEG-compress large screenshots so they fit the composer draft
 * cache. No-ops for small images, animated/vector formats, or environments
 * without canvas APIs (unit tests).
 */
export async function compressDraftImage(image: {
  data: string;
  mimeType: string;
}): Promise<{ data: string; mimeType: string }> {
  const mimeType = image.mimeType || "image/png";
  const originalBytes = decodedBase64ByteLength(image.data);
  if (originalBytes <= DRAFT_IMAGE_TARGET_BYTES) return image;
  if (isAnimatedOrVector(mimeType)) return image;
  if (typeof createImageBitmap !== "function") return image;

  let bitmap: ImageBitmap;
  try {
    const bytes = new Uint8Array(base64ToBytes(image.data));
    bitmap = await createImageBitmap(new Blob([bytes], { type: mimeType }));
  } catch {
    return image;
  }

  try {
    const maxEdge = Math.max(bitmap.width, bitmap.height, 1);
    let width = bitmap.width;
    let height = bitmap.height;
    if (maxEdge > DRAFT_IMAGE_MAX_DIMENSION) {
      const scale = DRAFT_IMAGE_MAX_DIMENSION / maxEdge;
      width = Math.max(1, Math.round(bitmap.width * scale));
      height = Math.max(1, Math.round(bitmap.height * scale));
    }

    let best = image;
    let bestBytes = originalBytes;
    const sizes = [
      { width, height },
      { width: Math.max(1, Math.round(width * 0.75)), height: Math.max(1, Math.round(height * 0.75)) },
    ];

    for (const size of sizes) {
      const canvas = createDraftCanvas(size.width, size.height);
      if (!canvas) return best;
      const ctx = getDraft2dContext(canvas);
      if (!ctx) return best;
      ctx.fillStyle = "#fff";
      ctx.fillRect(0, 0, size.width, size.height);
      ctx.drawImage(bitmap, 0, 0, size.width, size.height);
      for (const quality of [0.84, 0.72, 0.6]) {
        const blob = await canvasToBlob(canvas, "image/jpeg", quality);
        if (!blob || blob.size >= bestBytes) continue;
        best = { data: await blobToBase64(blob), mimeType: "image/jpeg" };
        bestBytes = blob.size;
        if (bestBytes <= DRAFT_IMAGE_TARGET_BYTES) return best;
      }
    }
    return best;
  } catch {
    return image;
  } finally {
    bitmap.close();
  }
}

export async function processImageFileBatch(
  files: File[],
  dependencies: ImageFileProcessingDependencies = browserDependencies,
): Promise<{ images: ProcessedImageFile[]; failures: ImageFileFailure[] }> {
  const compressImage = dependencies.compressImage ?? compressDraftImage;
  const settled = await Promise.allSettled(
    files.map(async (file) => {
      const previewUrl = dependencies.createObjectUrl(file);
      try {
        const dataUrl = await dependencies.readAsDataUrl(file);
        const separator = dataUrl.indexOf(",");
        if (separator < 0) throw new Error("Image reader returned an invalid data URL");
        const compressed = await compressImage({
          data: dataUrl.slice(separator + 1),
          mimeType: file.type || "image/png",
        });
        return {
          data: compressed.data,
          mimeType: compressed.mimeType,
          previewUrl,
        } satisfies ProcessedImageFile;
      } catch (error) {
        dependencies.revokeObjectUrl(previewUrl);
        throw error;
      }
    }),
  );

  const images: ProcessedImageFile[] = [];
  const failures: ImageFileFailure[] = [];
  settled.forEach((result, index) => {
    if (result.status === "fulfilled") images.push(result.value);
    else failures.push({ file: files[index], error: result.reason });
  });
  return { images, failures };
}
