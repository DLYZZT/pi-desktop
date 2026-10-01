import { useI18n } from "@/i18n";
import { useSessionToolSettings } from "@/hooks/useSessionToolSettings";
import { getPresetFromTools, getToolNamesForPreset, type SelectableToolPreset } from "@shared/tool-presets";
import { ORCHESTRATION_TOOL_NAMES } from "@shared/orchestration-tools";
import "./SessionToolsConfig.css";

export function SessionToolsConfig({ sessionId }: { sessionId: string | null }) {
  const { t } = useI18n();
  const { tools, loaded, running, busy, error, update } = useSessionToolSettings(sessionId);
  const preset = getPresetFromTools(tools);
  const labels = {
    none: t("permissionReadOnly", "Read only"),
    default: t("permissionStandard", "Standard"),
    full: t("permissionFull", "Full access"),
    custom: t("permissionCustom", "Custom"),
  };
  const descriptions = {
    none: t("permissionReadOnlyDescription", "No tools, read-only"),
    default: t("permissionStandardDescription", "4 built-in tools"),
    full: t("permissionFullDescription", "All built-in tools, code orchestration and tool search"),
  };
  return (
    <div className="session-tools-config" data-session-tools-config>
      <h3>{t("sessionToolsSettings", "Session tools")}</h3>
      <p className="session-tools-help">
        {t("sessionToolsScopeHelp", "These settings apply to the current session and are saved for reopening it.")}
      </p>
      {!sessionId ? (
        <p>{t("sessionToolsOpenSession", "Open a conversation to configure its tools.")}</p>
      ) : (
        <>
          <section className="session-tools-card">
            <h4>{t("sessionToolsAccess", "Tool access")}</h4>
            <div
              role="radiogroup"
              aria-label={t("sessionToolsAccess", "Tool access")}
              className="session-tools-presets"
            >
              {(["none", "default", "full"] as SelectableToolPreset[]).map((name) => (
                <button
                  key={name}
                  role="radio"
                  type="button"
                  aria-checked={preset === name}
                  data-tool-preset={name}
                  disabled={!loaded || busy || running}
                  onClick={() => void update({ type: "set_tools", toolNames: getToolNamesForPreset(name) })}
                >
                  <strong>{labels[name]}</strong>
                  <span>{descriptions[name]}</span>
                </button>
              ))}
            </div>
            {loaded && preset === "custom" && (
              <p className="session-tools-help">
                {t("sessionToolsCustomHelp", "This session uses a custom tool selection.")}
              </p>
            )}
          </section>
          <section className="session-tools-card" data-session-orchestration>
            <h4>{t("sessionToolsOrchestration", "Tool orchestration")}</h4>
            <p className="session-tools-help">
              {t(
                "sessionToolsPermissionHelp",
                "Code orchestration and tool search work with all eligible tools. Each actual tool call keeps its own permissions and confirmation requirements.",
              )}
            </p>
            {ORCHESTRATION_TOOL_NAMES.map((name) => {
              const tool = tools.find((entry) => entry.name === name);
              return (
                <label className="session-tools-entry" key={name}>
                  <span>
                    <code>{name}</code>
                    <span>
                      {name === "codemode"
                        ? t(
                            "sessionToolsCodemodeHelp",
                            "Compose tool calls with JavaScript, including chains, batches and result filtering.",
                          )
                        : t(
                            "sessionToolsSearchHelp",
                            "Find tools when needed and load their definitions for the model.",
                          )}
                    </span>
                    {loaded && !tool && (
                      <small>
                        {t(
                          "sessionToolsUnavailable",
                          "This tool is not loaded. Check whether its extension is disabled.",
                        )}
                      </small>
                    )}
                  </span>
                  <input
                    type="checkbox"
                    aria-label={name}
                    checked={tool?.active ?? false}
                    disabled={!loaded || !tool || busy || running || preset === "none"}
                    onChange={(event) => {
                      const names = new Set(
                        tools
                          .filter(
                            (entry) => entry.active && ORCHESTRATION_TOOL_NAMES.some((name) => name === entry.name),
                          )
                          .map((entry) => entry.name),
                      );
                      if (event.target.checked) names.add(name);
                      else names.delete(name);
                      void update({ type: "set_orchestration_tools", toolNames: [...names] });
                    }}
                  />
                </label>
              );
            })}
            {loaded && preset === "none" && (
              <p className="session-tools-help">
                {t("sessionToolsDisabledHelp", "Choose Standard or Full access before enabling orchestration tools.")}
              </p>
            )}
          </section>
          {running && (
            <p role="status">
              {t("sessionToolsRunning", "Wait for the current response to finish before changing tools.")}
            </p>
          )}
          {!loaded && !error && <p role="status">{t("sessionToolsLoading", "Loading session tools…")}</p>}
          {error && (
            <p role="alert" className="session-tools-error">
              {error}
            </p>
          )}
        </>
      )}
    </div>
  );
}
