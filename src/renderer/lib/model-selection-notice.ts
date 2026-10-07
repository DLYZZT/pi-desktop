import type { ModelSelectionNotice } from "@contract/types";

export function modelSelectionNoticeText(
  notice: ModelSelectionNotice,
  t: (key: string, fallback: string) => string,
): string {
  const requested = notice.requested
      ? `${notice.requested.provider}/${notice.requested.modelId}`
      : t("modelSelectionNone", "No model"),
    actual = notice.actual ? `${notice.actual.provider}/${notice.actual.modelId}` : t("modelSelectionNone", "No model");
  const template = notice.requiresChoice
    ? t(
        "modelSelectionRequired",
        "Could not safely restore {requested}. Current model: {actual}. Choose a model explicitly before sending.",
      )
    : t(
        "modelAzureSelectionRenamed",
        "Azure provider ID updated: {requested} → {actual}. Original conversation history is preserved.",
      );
  return template.replace("{requested}", requested).replace("{actual}", actual);
}
