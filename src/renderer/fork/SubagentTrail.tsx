import type { CSSProperties } from "react";
import type { ToolResultMessage } from "@/lib/types";
import { parseSubagentTrail, type SubagentTrail, type TrailItem, type TrailMark } from "./subagent-trail";

const bodyStyle: CSSProperties = {
  padding: "8px 12px",
  color: "var(--tool-fg)",
  fontSize: 12,
  lineHeight: 1.5,
  whiteSpace: "pre-wrap",
  wordBreak: "break-word",
};

const muted: CSSProperties = { color: "var(--text-dim)" };

export function ForkSubagentTrail({ result, expanded }: { result: ToolResultMessage; expanded: boolean }) {
  const trail = parseSubagentTrail(result.details, result.timestamp === undefined);
  if (!trail) return null;
  return <SubagentTrailView trail={trail} expanded={expanded} />;
}

export function SubagentTrailView({ trail, expanded }: { trail: SubagentTrail; expanded: boolean }) {
  return (
    <div data-testid="subagent-trail" style={bodyStyle}>
      {trail.header && <div style={{ fontWeight: 600 }}>{`${markGlyph(trail.mark)} ${trail.header}`}</div>}
      {trail.rows.map((row, index) => {
        const items = expanded ? row.items : row.collapsedItems;
        return (
          <div key={`${row.agent}-${row.step ?? index}`} style={{ marginTop: trail.header || index > 0 ? 8 : 0 }}>
            <div style={{ fontWeight: 600 }}>{`${markGlyph(row.mark)} ${row.agent}`}</div>
            {row.errorMessage && <div style={{ color: "var(--danger)" }}>{row.errorMessage}</div>}
            {items.map((item, itemIndex) => (
              <div key={itemIndex} style={muted}>
                {formatItem(item)}
              </div>
            ))}
            {row.usage && <div style={muted}>{row.usage}</div>}
          </div>
        );
      })}
    </div>
  );
}

function markGlyph(mark: TrailMark): string {
  if (mark === "live") return "⏳";
  if (mark === "fail") return "✗";
  return "✓";
}

function formatItem(item: TrailItem): string {
  if (item.type === "toolCall") return item.preview ? `→ ${item.name} ${item.preview}` : `→ ${item.name}`;
  return item.text;
}
