import { useState } from "react";
import { formatByteSize } from "@/lib/message-metadata";
import { scaledChatFont } from "@/lib/chat-appearance";
import type { AssistantContentBlock, TextContent, ImageContent } from "@/lib/types";

export function DeferredContentActions({
  content,
  onLoad,
}: {
  content: unknown;
  onLoad?: (entryId: string, blockIndex?: number) => Promise<void>;
}) {
  const [loadingKey, setLoadingKey] = useState<string | null>(null);
  const [loadError, setLoadError] = useState(false);
  if (!onLoad || !Array.isArray(content)) return null;
  const references = content.flatMap((block) => {
    if (!block || typeof block !== "object") return [];
    const deferred = (block as AssistantContentBlock | TextContent | ImageContent).deferredContent;
    return deferred ? [deferred] : [];
  });
  if (references.length === 0) return null;
  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 8 }}>
      {references.map((reference) => {
        const key = `${reference.entryId}:${reference.blockIndex ?? 0}`;
        const loading = loadingKey === key;
        return (
          <button
            key={key}
            type="button"
            disabled={loading}
            onClick={() => {
              setLoadingKey(key);
              setLoadError(false);
              void onLoad(reference.entryId, reference.blockIndex)
                .catch(() => setLoadError(true))
                .finally(() => setLoadingKey(null));
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
            {loading ? "Loading full content…" : `Load full content (${formatByteSize(reference.originalBytes)})`}
          </button>
        );
      })}
      {loadError && (
        <span style={{ color: "var(--danger)", fontSize: scaledChatFont(11) }}>Failed to load full content</span>
      )}
    </div>
  );
}
