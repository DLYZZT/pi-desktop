export interface ComposerSubmissionImage {
  data: string;
  mimeType: string;
  previewUrl: string;
}

export interface ComposerSubmissionSnapshot {
  value: string;
  images: ComposerSubmissionImage[];
  files: LocalFileReference[];
}

export function captureComposerSubmission(
  value: string,
  images: readonly ComposerSubmissionImage[],
  files: readonly LocalFileReference[] = [],
): ComposerSubmissionSnapshot {
  return {
    value,
    images: images.map((image) => ({
      ...image,
      previewUrl: `data:${image.mimeType};base64,${image.data}`,
    })),
    files: files.map((file) => ({ ...file })),
  };
}

export function failedComposerSubmissionAction(
  clearedAtRevision: number,
  currentRevision: number,
): "restore" | "preserve" {
  return clearedAtRevision === currentRevision ? "restore" : "preserve";
}

export function mergeFailedSubmissionImages(
  current: readonly ComposerSubmissionImage[],
  failed: readonly ComposerSubmissionImage[],
): ComposerSubmissionImage[] {
  const existing = new Set(current.map(imageKey));
  const merged = [...current];
  for (const image of failed) {
    const key = imageKey(image);
    if (existing.has(key)) continue;
    existing.add(key);
    merged.push({ ...image, previewUrl: `data:${image.mimeType};base64,${image.data}` });
  }
  return merged;
}

export function mergeFailedSubmissionFiles(
  current: readonly LocalFileReference[],
  failed: readonly LocalFileReference[],
): LocalFileReference[] {
  const existing = new Set(current.map((file) => localFileReferenceKey(file.path)));
  const merged = current.map((file) => ({ ...file }));
  for (const file of failed) {
    const key = localFileReferenceKey(file.path);
    if (!key || existing.has(key)) continue;
    existing.add(key);
    merged.push({ ...file });
  }
  return merged;
}

export function localFileReferenceKey(filePath: string): string {
  const normalized = filePath.replace(/\\/g, "/").replace(/\/{2,}/g, (slashes, offset) => (offset === 0 ? "//" : "/"));
  return /^[a-zA-Z]:\//.test(normalized) || normalized.startsWith("//") ? normalized.toLowerCase() : normalized;
}

function imageKey(image: ComposerSubmissionImage): string {
  return `${image.mimeType}\0${image.data}`;
}
import type { LocalFileReference } from "../../shared/file-url";

export type { LocalFileReference } from "../../shared/file-url";
