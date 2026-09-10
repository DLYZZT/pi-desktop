export type AppLanguage = "en-US" | "zh-CN" | "zh-TW";

export function isAppLanguage(value: unknown): value is AppLanguage {
  return value === "en-US" || value === "zh-CN" || value === "zh-TW";
}

export function resolveAppLanguage(saved: unknown, locale: string): AppLanguage {
  if (isAppLanguage(saved)) return saved;
  const parts = locale.toLowerCase().split(/[-_]/);
  if (parts[0] !== "zh") return "en-US";
  if (parts.includes("hant")) return "zh-TW";
  if (parts.includes("hans")) return "zh-CN";
  return parts.some((part) => ["tw", "hk", "mo"].includes(part)) ? "zh-TW" : "zh-CN";
}
