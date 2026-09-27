// Main and Agent Host share Node capabilities through shared/node. Shared and
// contract modules never import process-specific business modules. Renderer
// runtime paths must stay free of Node modules, even through shared barrels.
//
// Existing-code limits are explicit ceilings at the Plan 22 checkpoint. This
// file is reviewed configuration; the checker never raises limits itself.
export const architecturePolicy = {
  lineLimit: 1200,
  budgets: {
    "src/renderer/components/ChatInput.tsx": {
      maxLines: 2572,
      reason:
        "Draft and submission hooks own data and command lifecycles; composer menus and presentation remain for 22-08.",
    },
    "src/main/browser/browser-tab-manager.ts": {
      maxLines: 1840,
      reason:
        "Browser tab/control owner after capture, snapshot, script, network and input extraction; lifecycle and inspection orchestration remain.",
    },
    "src/renderer/components/SessionSidebar.tsx": {
      maxLines: 1778,
      reason:
        "Session rows/tree and title now have separate owners; workspace selection and project operations remain for 22-08.",
    },

    "src/renderer/components/MessageView.tsx": {
      maxLines: 2072,
      reason: "Existing rich text, attachment and tool rendering; no increase beyond this checkpoint.",
    },
    "src/renderer/components/channels/ChannelsConfig.tsx": {
      maxLines: 1924,
      reason: "Existing account and pairing UI; preserve behavior while future work separates its forms.",
    },
    "src/renderer/components/browser/BrowserSettings.tsx": {
      maxLines: 1592,
      reason: "Existing browser permission and profile settings; preserve their security checks.",
    },
    "src/renderer/components/AppShell.tsx": {
      maxLines: 1583,
      reason: "Reduced by 22-04 presentation extraction; remaining workspace and panel coordination.",
    },
    "src/agent-host/herdr/bridge.ts": {
      maxLines: 1580,
      reason: "Existing terminal/session coordination; lifecycle changes require native integration evidence.",
    },
    "src/agent-host/rpc-manager.ts": {
      maxLines: 1537,
      reason: "Existing SDK wrapper and extension bridge; retain runtime compatibility during extraction.",
    },
    "src/renderer/components/SettingsConfig.tsx": {
      maxLines: 1480,
      reason: "Existing application settings composition; keep a fixed ceiling.",
    },
    "src/main/browser/browser-service.ts": {
      maxLines: 1463,
      reason: "Existing Browser service and authorization routing; 22-06 changes must preserve its contracts.",
    },
    "src/renderer/components/ChatWindow.tsx": {
      maxLines: 1452,
      reason: "Chat presentation and the explicit temporary draft owner retained across new-session promotion.",
    },
    "src/renderer/hooks/useAgentSession.ts": {
      maxLines: 1420,
      reason: "22-03/04 command and turn coordination after model/history/viewport/events/UI extraction.",
    },
    "src/renderer/components/ToolchainsConfig.tsx": {
      maxLines: 1347,
      reason: "Existing constrained toolchain action UI; changes retain the action contract checks.",
    },
    "src/agent-host/managed-process/service.ts": {
      maxLines: 1324,
      reason: "Existing process lifetime owner; moving shared helpers must not duplicate service instances.",
    },
    "src/main/toolchains/manager.ts": {
      maxLines: 1219,
      reason: "Existing toolchain installation/validation owner; keep its bounded-operation behavior.",
    },
  },
  // Domain dictionaries now fit the ordinary module limit. Their static
  // composition, duplicate keys and language parity are checked by check:i18n.
  dataModules: {},
  // An exception, when necessary, must name an exact rule/from/to edge and
  // provide both reason and removeWhen. Wildcards and unused exceptions fail.
  exceptions: [],
};
