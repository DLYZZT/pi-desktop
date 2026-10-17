import { useI18n } from "@/i18n";

export interface ShellToolChoicesState {
  error?: string;
  tools: Array<{ name: string; available?: boolean; active: boolean }>;
}
export function ShellToolChoices({
  state,
  onChange,
}: {
  state?: ShellToolChoicesState;
  onChange?: (name: string, enabled: boolean) => void;
}) {
  const { t } = useI18n();
  if (!state) return null;
  return (
    <>
      {state.tools.some((tool) => tool.name === "powershell") &&
        state.tools.map((tool) => (
          <label
            key={tool.name}
            style={{ display: "flex", gap: 8, padding: "7px 12px", fontSize: 12, alignItems: "center" }}
          >
            <input
              type="checkbox"
              checked={tool.active}
              disabled={!onChange || (tool.available === false && !tool.active)}
              onChange={(event) => onChange?.(tool.name, event.target.checked)}
            />
            {tool.name === "powershell" ? "PowerShell" : "Bash"}
            {tool.available === false && (
              <span style={{ color: "var(--text-dim)" }}>
                {t("shellToolUnavailable", "Unavailable; configure Developer tools and reload")}
              </span>
            )}
          </label>
        ))}
      {state.error && (
        <div role="alert" style={{ color: "var(--danger)", fontSize: 12, padding: 8 }}>
          {state.error}
        </div>
      )}
    </>
  );
}
