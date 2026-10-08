import { useEffect, useRef, useState } from "react";
import { useI18n } from "@/i18n";
import type { ImageContent } from "@/lib/types";
import { persistedImageSource } from "@/lib/persisted-image";

export function ReplyImage({
  image,
  onLoad,
}: {
  image: ImageContent;
  onLoad?: (entryId: string, blockIndex?: number) => Promise<void>;
}) {
  const { t } = useI18n();
  const target = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const deferred = image.deferredContent;
  const src = persistedImageSource(image);
  const entryId = deferred?.entryId;
  const blockIndex = deferred?.blockIndex;

  useEffect(() => {
    if (!entryId || !target.current) return;
    if (typeof IntersectionObserver === "undefined") {
      setVisible(true);
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setVisible(true);
          observer.disconnect();
        }
      },
      { rootMargin: "200px" },
    );
    observer.observe(target.current);
    return () => observer.disconnect();
  }, [entryId, blockIndex]);

  useEffect(() => {
    if (!visible || !entryId || !onLoad) return;
    let active = true;
    setFailed(false);
    void onLoad(entryId, blockIndex).catch(() => {
      if (active) setFailed(true);
    });
    return () => {
      active = false;
    };
  }, [visible, entryId, blockIndex, onLoad, attempt]);

  if (!src && !deferred) return null;
  return (
    <div ref={target} style={{ minHeight: src ? undefined : 120 }}>
      {src ? (
        <img
          src={src}
          alt={t("replyImage", "Image in reply")}
          loading="lazy"
          style={{
            display: "block",
            maxWidth: "100%",
            maxHeight: 640,
            objectFit: "contain",
            borderRadius: 10,
            border: "1px solid var(--border)",
          }}
        />
      ) : (
        <div
          role="status"
          style={{ padding: 16, border: "1px solid var(--border)", borderRadius: 10, color: "var(--text-muted)" }}
        >
          {failed
            ? t("replyImageLoadError", "Could not load this image from history.")
            : t("replyImageLoading", "Loading image…")}
          {failed && (
            <button
              type="button"
              onClick={() => setAttempt((value) => value + 1)}
              style={{ marginLeft: 10, color: "var(--accent)", cursor: "pointer" }}
            >
              {t("replyImageRetry", "Retry loading image")}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
