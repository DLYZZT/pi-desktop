import { useI18n } from "@/i18n";
import type { ApiKeyProviderStatus } from "@contract/types";
import { SectionTitle } from "../form-controls";
import { ModelConnectionTest } from "./ModelConnectionTest";

/** Provider catalog entries that Codemode uses independently of chat-model preferences. */
export function AuxiliaryModels({
  models,
  providerId,
}: {
  models: NonNullable<ApiKeyProviderStatus["auxiliaryModels"]>;
  providerId?: string;
}) {
  const { t } = useI18n();
  if (!models.length) return null;
  return (
    <section
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 10,
        paddingTop: 16,
        borderTop: "1px solid var(--border)",
      }}
    >
      <SectionTitle>{t("modelAuxiliaryModels", "Image and decision models")}</SectionTitle>
      <p style={{ margin: 0, fontSize: 11, color: "var(--text-muted)", lineHeight: 1.5 }}>
        {t(
          "modelAuxiliaryDescription",
          "These catalog models are used through Codemode with supported provider credentials. Enable Codemode in the session tools menu. They do not appear in the chat model picker.",
        )}
      </p>
      {providerId && (
        <p style={{ margin: 0, fontSize: 11, color: "var(--text-muted)" }}>
          {t(
            "modelTestUsageHint",
            "Tests send a small decision request or generate one sample image using your provider credentials and may incur usage charges.",
          )}
        </p>
      )}
      <div style={{ maxHeight: 260, overflowY: "auto", border: "1px solid var(--border)", borderRadius: 6 }}>
        {models.map((model, index) => (
          <div
            key={`${model.type}:${model.id}`}
            style={{ padding: "8px 10px", borderTop: index ? "1px solid var(--border)" : undefined }}
          >
            <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 12 }}>
              <span style={{ fontSize: 12, color: "var(--text)", overflowWrap: "anywhere" }}>{model.name}</span>
              <span style={{ fontSize: 10, color: "var(--text-dim)", flexShrink: 0 }}>
                {model.type === "classifier"
                  ? t("modelDecision", "Decision")
                  : t("modelImageGeneration", "Image generation")}
              </span>
            </div>
            <code style={{ fontSize: 10, color: "var(--text-dim)", overflowWrap: "anywhere" }}>{model.id}</code>
            {providerId && <ModelConnectionTest provider={providerId} modelId={model.id} type={model.type} />}
          </div>
        ))}
      </div>
    </section>
  );
}
