export interface ProcessedImageFile {
  data: string;
  mimeType: string;
  previewUrl: string;
}

export interface ImageFileFailure {
  file: File;
  error: unknown;
}

interface ImageFileProcessingDependencies {
  readAsDataUrl: (file: File) => Promise<string>;
  createObjectUrl: (file: File) => string;
  revokeObjectUrl: (url: string) => void;
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
};

export async function processImageFileBatch(
  files: File[],
  dependencies: ImageFileProcessingDependencies = browserDependencies,
): Promise<{ images: ProcessedImageFile[]; failures: ImageFileFailure[] }> {
  const settled = await Promise.allSettled(
    files.map(async (file) => {
      const previewUrl = dependencies.createObjectUrl(file);
      try {
        const dataUrl = await dependencies.readAsDataUrl(file);
        const separator = dataUrl.indexOf(",");
        if (separator < 0) throw new Error("Image reader returned an invalid data URL");
        return {
          data: dataUrl.slice(separator + 1),
          mimeType: file.type,
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
