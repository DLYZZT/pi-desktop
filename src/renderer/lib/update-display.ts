import type { CSSProperties } from "react";
import type { DesktopUpdateState } from "../../contract/desktop";
import type { AppLanguage } from "../../shared/app-language";

export function updateStatusColor(phase: DesktopUpdateState["phase"] | undefined): string {
  if (phase === "error") return "#f87171";
  if (phase === "available" || phase === "downloaded") return "var(--accent)";
  if (phase === "up-to-date") return "#4ade80";
  return "var(--text-dim)";
}

export function displayVersion(version: string): string {
  return version.startsWith("v") ? version : `v${version}`;
}

export function formatUpdateDate(value: string, language: AppLanguage): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat(language, { dateStyle: "medium", timeStyle: "short" }).format(date);
}

export function formatBytes(value: number, language: AppLanguage): string {
  if (!Number.isFinite(value) || value <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const unitIndex = Math.max(0, Math.min(Math.floor(Math.log(value) / Math.log(1024)), units.length - 1));
  const amount = value / 1024 ** unitIndex;
  return `${new Intl.NumberFormat(language, { maximumFractionDigits: unitIndex === 0 ? 0 : 1 }).format(amount)} ${units[unitIndex]}`;
}

export const updateDetailStyle: CSSProperties = {
  margin: "12px 0 0",
  fontSize: 12,
  lineHeight: 1.55,
  color: "var(--text-muted)",
};
