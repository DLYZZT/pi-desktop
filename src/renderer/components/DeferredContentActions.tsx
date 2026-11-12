import { useState } from "react";
import { useI18n } from "@/i18n";
import { formatByteSize } from "@/lib/message-metadata";
import { scaledChatFont } from "@/lib/chat-appearance";
import type {
  AssistantContentBlock,
  DeferredContentRef,
  ImageContent,
  LoadDeferredContent,
  TextContent,
} from "@/lib/types";

export function DeferredContentActions({
  content,
  details,
  onLoad,
}: {
  content: unknown;
  /** Reference to a message's omitted `details`, loaded separately from its content blocks. */
  details?: DeferredContentRef;
  onLoad?: LoadDeferredContent;
}) {
  const { t } = useI18n();
  const [loadingKey, setLoadingKey] = useState<string | null>(null);
  const [loadError, setLoadError] = useState(false);
  if (!onLoad) return null;
  const references: { key: string; reference: DeferredContentRef; isDetails: boolean }[] = (
    Array.isArray(content) ? content : []
  ).flatMap((block) => {
    if (!block || typeof block !== "object") return [];
    const deferred = (block as AssistantContentBlock | TextContent | ImageContent).deferredContent;
    return deferred
      ? [{ key: `${deferred.entryId}:${deferred.blockIndex ?? 0}`, reference: deferred, isDetails: false }]
      : [];
  });
  if (details) references.push({ key: `${details.entryId}:details`, reference: details, isDetails: true });
  if (references.length === 0) return null;
  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 8 }}>
      {references.map(({ key, reference, isDetails }) => {
        const loading = loadingKey === key;
        const size = formatByteSize(reference.originalBytes);
        return (
          <button
            key={key}
            type="button"
            disabled={loading}
            onClick={() => {
              setLoadingKey(key);
              setLoadError(false);
              const request = isDetails
                ? onLoad(reference.entryId, undefined, "details")
                : onLoad(reference.entryId, reference.blockIndex);
              void request.catch(() => setLoadError(true)).finally(() => setLoadingKey(null));
            }}
            style={{
              border: "1px solid var(--border)",
              borderRadius: 6,
              background: "var(--bg-panel)",
              color: "var(--accent)",
              cursor: loading ? "default" : "pointer",
              fontSize: scaledChatFont(11),
              padding: "4px 8px",
            }}
          >
            {isDetails
              ? loading
                ? t("deferredDetailsLoading", "Loading full details…")
                : t("deferredDetailsLoad", "Load full details ({size})").replace("{size}", size)
              : loading
                ? t("deferredContentLoading", "Loading full content…")
                : t("deferredContentLoad", "Load full content ({size})").replace("{size}", size)}
          </button>
        );
      })}
      {loadError && (
        <span style={{ color: "var(--danger)", fontSize: scaledChatFont(11) }}>
          {t("deferredContentLoadError", "Failed to load full content")}
        </span>
      )}
    </div>
  );
}
