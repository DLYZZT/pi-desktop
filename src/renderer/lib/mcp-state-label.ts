import type { McpConnectionState, McpOAuthSnapshot } from "../../contract/mcp";
type Translate = (key: string, fallback: string) => string;
export function mcpStateLabel(state: McpConnectionState, t: Translate): string {
  const labels = {
    disabled: t("mcpStateDisabled", "Disabled"),
    "not-started": t("mcpStateNotStarted", "Not started"),
    connecting: t("mcpStateConnecting", "Connecting"),
    connected: t("mcpStateConnected", "Connected"),
    "needs-auth": t("mcpStateNeedsAuth", "Sign-in required"),
    disconnected: t("mcpStateDisconnected", "Disconnected"),
    failed: t("mcpStateFailed", "Failed"),
  };
  return labels[state];
}
export function mcpLoginLabel(state: McpOAuthSnapshot["state"], t: Translate): string {
  const labels = {
    waiting: t("mcpLoginWaiting", "Waiting for authorization"),
    succeeded: t("mcpLoginSucceeded", "Sign-in completed"),
    cancelled: t("mcpLoginCancelled", "Sign-in cancelled"),
    failed: t("mcpLoginFailed", "Sign-in failed"),
  };
  return labels[state];
}
