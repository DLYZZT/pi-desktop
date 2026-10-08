import { useI18n } from "@/i18n";
import type { ToolResultMessage } from "@/lib/types";
import { persistedImageSource } from "@/lib/persisted-image";

export function ToolResultImages({ content }: { content: ToolResultMessage["content"] }) {
  const { t } = useI18n();
  // Only display persisted raster data. A tool's path or URL is not an attachment.
  const images = content.flatMap((block) => {
    const src = block.type === "image" ? persistedImageSource(block) : undefined;
    return src ? [src] : [];
  });
  if (images.length === 0) return null;
  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: 8, padding: "8px 12px" }}>
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
