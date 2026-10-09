import { useEffect, useRef, useState } from "react";
import { useI18n } from "@/i18n";
import { Field } from "../form-controls";

export function JsonObjectField({
  label,
  value,
  example,
  onChange,
  onValidityChange,
}: {
  label: string;
  example?: string;
  value?: Record<string, unknown>;
  onChange: (value: Record<string, unknown> | undefined) => void;
  onValidityChange?: (valid: boolean) => void;
}) {
  const { t } = useI18n();
  const serialized = JSON.stringify(value);
  const last = useRef(serialized);
  const [text, setText] = useState(value ? JSON.stringify(value, null, 2) : "");
  const [error, setError] = useState(false);
  useEffect(() => {
    if (last.current === serialized) return;
    last.current = serialized;
    setText(serialized ? JSON.stringify(JSON.parse(serialized), null, 2) : "");
    setError(false);
  }, [serialized]);
  return (
    <Field label={label}>
      <textarea
        aria-label={label}
        placeholder={example}
        value={text}
        rows={5}
        spellCheck={false}
        style={{
          width: "100%",
          boxSizing: "border-box",
          resize: "vertical",
          padding: 8,
          background: "var(--bg)",
          color: "var(--text)",
          border: "1px solid var(--border)",
          borderRadius: 5,
          fontFamily: "var(--font-mono)",
          fontSize: 12,
        }}
        onChange={(event) => {
          const next = event.target.value;
          setText(next);
          try {
            const parsed: unknown = next.trim() ? JSON.parse(next) : undefined;
            if (parsed !== undefined && (!parsed || typeof parsed !== "object" || Array.isArray(parsed)))
              throw new Error();
            last.current = JSON.stringify(parsed);
            setError(false);
            onValidityChange?.(true);
            onChange(parsed as Record<string, unknown> | undefined);
          } catch {
            setError(true);
            onValidityChange?.(false);
          }
        }}
      />
      {error && (
        <span role="alert" style={{ color: "#ef4444" }}>
          {t("modelJsonObjectRequired", "Enter a valid JSON object, or leave empty to use defaults.")}
        </span>
      )}
    </Field>
  );
}
