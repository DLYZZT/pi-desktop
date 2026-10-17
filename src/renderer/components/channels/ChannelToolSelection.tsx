import { useI18n } from "@/i18n";
import { useCodingToolChoices } from "@/hooks/useCodingToolChoices";
import { getToolNamesForPreset } from "@shared/tool-presets";
import { isOrchestrationTool } from "@shared/orchestration-tools";

export function ChannelToolSelection({
  toolNames,
  cwd,
  onChange,
}: {
  toolNames: string[];
  cwd?: string;
  onChange: (names: string[]) => void;
}) {
  const { t } = useI18n();
  const codingTools = useCodingToolChoices(cwd);
  const presets = {
    none: [],
    read: ["read", "grep", "find", "ls"],
    full: getToolNamesForPreset("full", codingTools).filter((name) => !isOrchestrationTool(name)),
  };
  const key = [...toolNames].sort().join(",");
  const preset = Object.entries(presets).find(([, names]) => [...names].sort().join(",") === key)?.[0] ?? "custom";
  return (
    <>
      <select
        aria-label={t("defaultTools", "Default tools")}
        value={preset}
        style={{
          width: "100%",
          minHeight: 36,
          background: "var(--bg)",
          color: "var(--text)",
          border: "1px solid var(--border)",
          borderRadius: 6,
        }}
        onChange={(event) => onChange([...presets[event.target.value as keyof typeof presets]])}
      >
        <option value="custom" disabled>
          {t("permissionCustom", "Custom")}
        </option>
        <option value="none">{t("toolPresetNone", "No tools (recommended)")}</option>
        <option value="read">{t("toolPresetRead", "Read-only tools")}</option>
        <option value="full">{t("toolPresetFull", "Full coding tools")}</option>
      </select>
      <span style={{ color: "var(--text-dim)", fontSize: 10, lineHeight: 1.5 }}>
        {t(
          "defaultToolsHint",
          "Used for new channel sessions and synchronized to sessions currently bound to this account when saved.",
        )}
      </span>
    </>
  );
}
