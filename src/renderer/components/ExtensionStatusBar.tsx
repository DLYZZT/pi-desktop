import { useI18n } from "@/i18n";
import { scaledChatFont } from "@/lib/chat-appearance";

export function ExtensionStatusBar({ statuses }: { statuses: Array<{ key: string; text: string }> }) {
  const { t } = useI18n();
  if (statuses.length === 0) return null;
  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 10 }}>
      {statuses.map((status) => (
        <div
          key={status.key}
          style={{
            display: "flex",
            alignItems: "center",
            gap: 6,
            maxWidth: "100%",
            padding: "4px 8px",
            border: "1px solid color-mix(in srgb, var(--accent) 24%, var(--border))",
            borderRadius: 6,
            background: "color-mix(in srgb, var(--accent) 7%, var(--bg))",
            color: "var(--text-muted)",
            fontSize: scaledChatFont(12),
          }}
        >
          <span style={{ color: "var(--accent)", fontFamily: "var(--font-mono)", fontSize: scaledChatFont(11) }}>
            {status.key === "pi-model-selection" ? t("model", "Model") : status.key}
          </span>
          <span
            style={{
              minWidth: 0,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: status.key === "pi-model-selection" ? "normal" : "nowrap",
              overflowWrap: "anywhere",
            }}
          >
            {status.text}
          </span>
        </div>
      ))}
    </div>
  );
}
