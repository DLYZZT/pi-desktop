import { useI18n } from "@/i18n";
import type { ToolResultMessage } from "@/lib/types";

export function ToolResultImages({ content }: { content: ToolResultMessage["content"] }) {
  const { t } = useI18n();
  // Only display persisted raster data. A tool's path or URL is not an attachment.
  const images = content.flatMap((block) => {
    if (block.type !== "image" || block.deferredContent) return [];
    const flat = block as unknown as { data?: string; mimeType?: string };
    const data = block.source ? (block.source.type === "base64" ? block.source.data : undefined) : flat.data;
    const mimeType = block.source ? block.source.media_type : flat.mimeType;
    return data && /^image\/(?:png|jpeg|gif|webp)$/.test(mimeType ?? "") ? [`data:${mimeType};base64,${data}`] : [];
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
