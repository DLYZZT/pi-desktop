import { useI18n } from "@/i18n";
import { scaledChatFont } from "@/lib/chat-appearance";
import type { SessionRetryInfo } from "@contract/types";

export function RetryStatus({ retryInfo }: { retryInfo: SessionRetryInfo }) {
  const { t } = useI18n();
  const { modelSwitch } = retryInfo;
  const error = retryInfo.errorMessage ?? "";
  const reason = /\b429\b|rate.?limit|too many requests/i.test(error)
    ? t("retryRateLimited", "Provider rate limit reached")
    : /\b5\d\d\b|overload|unavailable|api_error/i.test(error)
      ? t("retryUnavailable", "Model service temporarily unavailable")
      : /network|connection|timed? ?out|fetch failed/i.test(error)
        ? t("retryConnectionInterrupted", "Connection interrupted")
        : t("retryTemporary", "Temporary request failure");
  return (
    <div
      role="status"
      style={{
        marginBottom: 8,
        padding: "5px 10px",
        background: "rgba(234,179,8,0.08)",
        border: "1px solid rgba(234,179,8,0.25)",
        borderRadius: 6,
        fontSize: scaledChatFont(12),
        color: "rgba(180,130,0,0.9)",
        display: "flex",
        flexWrap: "wrap",
        overflowWrap: "anywhere",
        alignItems: "center",
        gap: 6,
      }}
    >
      <svg
        width="11"
        height="11"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        style={{ flexShrink: 0 }}
      >
        <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
        <path d="M3 3v5h5" />
      </svg>
      {t("retrying", "Retrying")} ({retryInfo.attempt}/{retryInfo.maxAttempts})…
      {modelSwitch && (
        <span>
          {t("modelRetrySwitch", "Auto switched from {from} to {to} after the failed attempt").replace(
            /\{(from|to)\}/g,
            (_, key: "from" | "to") => modelSwitch[key],
          )}
        </span>
      )}
      {error && (
        <>
          <span>{reason}</span>
          <details style={{ maxWidth: "100%" }}>
            <summary>{t("retryResponseDetails", "Provider response")}</summary>
            <pre style={{ whiteSpace: "pre-wrap", maxHeight: 160, overflow: "auto" }}>{error}</pre>
          </details>
        </>
      )}
    </div>
  );
}
