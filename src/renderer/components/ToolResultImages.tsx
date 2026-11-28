import { useI18n } from "@/i18n";
import type { ToolResultMessage } from "@/lib/types";
import { persistedImageSource } from "@/lib/persisted-image";
import { readImagePlaceholderModel } from "@shared/normalize";

export function readPlaceholderModel(toolName: string, result: ToolResultMessage) {
  return (
    readImagePlaceholderModel(toolName, result.details) ??
    (toolName === "read" && result.deferredDetails && typeof result.readImagePlaceholderModel === "string"
      ? result.readImagePlaceholderModel
      : undefined)
  );
}

export function ReadImageWarning({ model }: { model: string }) {
  const { t } = useI18n();
  return (
    <div className="read-image-warning">
      {t(
        "readImagePlaceholder",
        "{model} received a placeholder for this image because it does not support images.",
      ).replace("{model}", () => model)}
    </div>
  );
}

export function ToolResultImages({ toolName, result }: { toolName: string; result: ToolResultMessage }) {
  const { t } = useI18n();
  const { content } = result;
  const unsupportedBy = readPlaceholderModel(toolName, result);
  // Only display persisted raster data. A tool's path or URL is not an attachment.
  const images = content.flatMap((block) => {
    const src = block.type === "image" ? persistedImageSource(block) : undefined;
    return src ? [src] : [];
  });
  if (!unsupportedBy && images.length === 0) return null;
  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: 8, padding: "8px 12px" }}>
      {unsupportedBy && <ReadImageWarning model={unsupportedBy} />}
      {images.map((src, index) => (
        <img
          key={index}
          src={src}
          alt={t("toolResultImage", "Tool result image")}
          style={{ maxWidth: "100%", maxHeight: 360, objectFit: "contain", borderRadius: 6 }}
        />
      ))}
    </div>
  );
}
