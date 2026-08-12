export interface ComposerSubmissionImage {
  data: string;
  mimeType: string;
  previewUrl: string;
}

export interface ComposerSubmissionSnapshot {
  value: string;
  images: ComposerSubmissionImage[];
}

export function captureComposerSubmission(
  value: string,
  images: readonly ComposerSubmissionImage[],
): ComposerSubmissionSnapshot {
  return {
    value,
    images: images.map((image) => ({
      ...image,
      previewUrl: `data:${image.mimeType};base64,${image.data}`,
    })),
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

function imageKey(image: ComposerSubmissionImage): string {
  return `${image.mimeType}\0${image.data}`;
}
