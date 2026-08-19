import type { CSSProperties } from "react";
import type { ForkStatusChip } from "./usage";

const chipStyle: CSSProperties = {
  maxWidth: 220,
  padding: "4px 8px",
  borderRadius: 999,
  border: "1px solid var(--border)",
  background: "var(--bg-panel)",
  color: "var(--text-muted)",
  fontSize: 11,
  lineHeight: "20px",
  whiteSpace: "nowrap",
  overflow: "hidden",
  textOverflow: "ellipsis",
  flexShrink: 1,
};

export function ForkUsageChips({ chips }: { chips?: ForkStatusChip[] }) {
  const visible = (chips ?? []).filter((chip) => chip.text.trim().length > 0);
  if (visible.length === 0) return null;
  return (
    <>
      {visible.map((chip) => (
        <span key={chip.key} title={`${chip.key}: ${chip.text}`} style={chipStyle}>
          {chip.text}
        </span>
      ))}
    </>
  );
}
