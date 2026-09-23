import type { ExtensionUiRequest } from "@shared/types";

type Translate = (key: string, fallback: string) => string;
type ConfirmRequest = Extract<ExtensionUiRequest, { method: "confirm" }>;

function format(template: string, values: Record<string, string | number>): string {
  return template.replace(/\{([A-Za-z0-9_]+)\}/g, (token, key: string) =>
    Object.prototype.hasOwnProperty.call(values, key) ? String(values[key]) : token,
  );
}

export function localizedExtensionConfirmCopy(
  request: ConfirmRequest,
  t: Translate,
): { title: string; message: string } {
  const localization = request.localization;
  if (!localization) return { title: request.title, message: request.message };
  if (localization.id === "herdr.closeWorkspace") {
    return {
      title: t("herdrCloseWorkspaceTitle", "Close Herdr workspace"),
      message: format(
        t(
          "herdrCloseWorkspaceMessage",
          "Close workspace {target}? This will terminate {paneCount} pane(s) and all processes in them. This cannot be undone by Pi Desktop.",
        ),
        { target: localization.target, paneCount: localization.paneCount },
      ),
    };
  }
  if (localization.id === "herdr.closePane") {
    return {
      title: t("herdrClosePaneTitle", "Close Herdr pane"),
      message: format(
        t(
          "herdrClosePaneMessage",
          "Close pane {target}? This will terminate its shell, Agent, and other processes. This cannot be undone by Pi Desktop.",
        ),
        { target: localization.target },
      ),
    };
  }
  return {
    title: t("herdrCloseAgentPaneTitle", "Close Herdr Agent pane"),
    message: format(
      t(
        "herdrCloseAgentPaneMessage",
        "Close the {agentKind} Agent by closing pane {paneId}? Herdr v0.8.2 cannot stop only the Agent; the pane and every process in it will terminate.",
      ),
      { agentKind: localization.agentKind, paneId: localization.paneId },
    ),
  };
}
