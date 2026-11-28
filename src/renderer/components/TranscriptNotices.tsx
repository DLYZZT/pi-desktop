import type { TranscriptNotice } from "@shared/transcript-notices";
import { useI18n } from "@/i18n";

export function TranscriptNotices({ notices }: { notices: TranscriptNotice[] }) {
  const { t, language } = useI18n();
  function describe(notice: TranscriptNotice) {
    if (notice.kind === "reasoningDrops") {
      const summary = t("transcriptReasoningDropped", "{provider} dropped {count} reasoning items.")
        .replace("{provider}", notice.provider)
        .replace("{count}", String(notice.count));
      return notice.reasons.length ? `${summary} (${notice.reasons.join(", ")})` : summary;
    }
    const tokens = notice.tokens.toLocaleString(language);
    if (notice.kind === "cacheMisses")
      return t("transcriptCacheMiss", "{tokens} prompt tokens missed the cache.").replace("{tokens}", tokens);
    const cost = new Intl.NumberFormat(language, {
      style: "currency",
      currency: "USD",
      maximumFractionDigits: 6,
    }).format(notice.cost);
    const template =
      notice.kind === "cacheWarming"
        ? t("transcriptWarmCost", "Cache warming used {tokens} tokens ({cost}).")
        : notice.branchSummary
          ? t("transcriptBranchCost", "Branch summary used {tokens} tokens ({cost}).")
          : t("transcriptCompactCost", "Compaction used {tokens} tokens ({cost}).");
    return template.replace("{tokens}", tokens).replace("{cost}", cost);
  }
  return (
    <aside style={{ color: "var(--text-muted)", fontSize: "0.85em", margin: "6px 0" }}>
      {notices.map((notice, i) => (
        <div key={i}>{describe(notice)}</div>
      ))}
    </aside>
  );
}
