import { useState } from "react";
import { call } from "@/lib/api-client";
import { useI18n } from "@/i18n";

export function ModelConnectionTest({
  provider,
  modelId,
  type,
}: {
  provider: string;
  modelId: string;
  type: "chat" | "image" | "classifier";
}) {
  const { t } = useI18n();
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; text: string }>();
  return (
    <div style={{ marginTop: 6, fontSize: 11 }}>
      <button
        type="button"
        disabled={busy}
        style={{
          padding: "4px 8px",
          border: "1px solid var(--border)",
          borderRadius: 4,
          background: "var(--bg)",
          color: "var(--text)",
        }}
        onClick={async () => {
          setBusy(true);
          setResult(undefined);
          try {
            const response = await call("models.test", { provider, modelId, type });
            setResult({
              ok: response.ok,
              text: response.ok
                ? `${t("modelTestPassed", "Test passed")} · ${response.latencyMs ?? 0} ms · ${response.responseText ?? ""}`
                : (response.error ?? t("modelConnectionFailed", "Failed")),
            });
          } catch (error) {
            setResult({ ok: false, text: String(error) });
          } finally {
            setBusy(false);
          }
        }}
      >
        {busy ? t("modelTesting", "Testing…") : t("modelTestRequest", "Send test request")}
      </button>
      {result && (
        <div
          role="status"
          style={{ marginTop: 5, color: result.ok ? "var(--text-muted)" : "#ef4444", overflowWrap: "anywhere" }}
        >
          {result.text}
        </div>
      )}
    </div>
  );
}
