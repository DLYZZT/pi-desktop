import type { AppLanguage } from "../i18n.ts";

export function formatNumber(value: number, language: AppLanguage): string {
  return new Intl.NumberFormat(language).format(value);
}

export function formatCompactNumber(value: number, language: AppLanguage): string {
  return new Intl.NumberFormat(language, { notation: "compact", maximumFractionDigits: 1 }).format(value);
}

export function formatRelativeDateTime(
  value: string | number | Date,
  language: AppLanguage,
  now: number | Date = Date.now(),
): string {
  const date = value instanceof Date ? value : new Date(value);
  const nowMs = now instanceof Date ? now.getTime() : now;
  if (Number.isNaN(date.getTime())) return "";

  const diffSeconds = Math.round((date.getTime() - nowMs) / 1000);
  const absoluteSeconds = Math.abs(diffSeconds);
  const formatter = new Intl.RelativeTimeFormat(language, { numeric: "auto" });
  if (absoluteSeconds < 60) return formatter.format(0, "second");
  if (absoluteSeconds < 3600) return formatter.format(Math.round(diffSeconds / 60), "minute");
  if (absoluteSeconds < 86_400) return formatter.format(Math.round(diffSeconds / 3600), "hour");
  if (absoluteSeconds < 7 * 86_400) return formatter.format(Math.round(diffSeconds / 86_400), "day");
  return new Intl.DateTimeFormat(language, { dateStyle: "medium" }).format(date);
}

export function formatFileSize(bytes: number, language: AppLanguage): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let amount = bytes;
  let unitIndex = 0;
  while (amount >= 1024 && unitIndex < units.length - 1) {
    amount /= 1024;
    unitIndex += 1;
  }
  return `${new Intl.NumberFormat(language, { maximumFractionDigits: unitIndex === 0 ? 0 : 1 }).format(amount)} ${units[unitIndex]}`;
}
