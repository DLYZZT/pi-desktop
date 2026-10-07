import type { AzureUpgradeReport } from "@contract/types";
import { useI18n } from "@/i18n";

export function AzureUpgradeNotice({ report }: { report?: AzureUpgradeReport }) {
  const { t } = useI18n();
  if (!report || report.status === "unchanged") return null;
  return (
    <div
      role={report.status === "review" ? "alert" : "status"}
      data-azure-upgrade
      style={{
        padding: "10px 16px",
        borderBottom: "1px solid var(--border)",
        flexShrink: 0,
        fontSize: 12,
        overflowWrap: "anywhere",
      }}
    >
      <p>
        {report.status === "review"
          ? t(
              "modelAzureUpgradeReview",
              "Azure configuration needs review. Existing entries were preserved. Resolve conflicting provider entries in Models, then choose the intended model explicitly.",
            )
          : t(
              "modelAzureUpgradeDone",
              "Azure configuration was upgraded and original files were backed up. The provider ID is azure; the Responses API type remains azure-openai-responses.",
            )}
      </p>
      <details style={{ maxHeight: 160, overflowY: "auto" }}>
        <summary>{t("modelAzureUpgradeDetails", "Migration details and backups")}</summary>
        <ul>
          {[...report.issues, ...report.backups].map((value, index) => (
            <li key={index}>{value}</li>
          ))}
        </ul>
      </details>
    </div>
  );
}
