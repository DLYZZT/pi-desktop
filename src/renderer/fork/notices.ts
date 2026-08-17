import type { CSSProperties } from "react";

const NOTICE_VISIBLE_MS = 5_000;

export function forkNoticeDurationMs(message: string): number {
  const multiline = message.includes("\n") || message.length > 80;
  return multiline ? NOTICE_VISIBLE_MS * 4 : NOTICE_VISIBLE_MS;
}

export function forkNoticeItemStyle(): CSSProperties {
  return {
    minHeight: 40,
    height: "auto",
    maxHeight: 240,
    alignItems: "flex-start",
  };
}

export function forkNoticeMessageStyle(): CSSProperties {
  return {
    padding: "10px 0",
    overflow: "auto",
    whiteSpace: "pre-wrap",
    wordBreak: "break-word",
    fontSize: 13,
    lineHeight: 1.4,
  };
}
