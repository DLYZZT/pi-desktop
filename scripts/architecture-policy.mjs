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
      maxLines: 3138,
      reason: "Existing input, attachment and mention UI; scheduled for 22-08.",
    },
    "src/main/browser/browser-tab-manager.ts": {
      maxLines: 2522,
      reason:
        "Browser tab/control owner after capture, DOM script and timing extraction; further 22-06 operation boundaries remain.",
    },
    "src/renderer/components/ModelsConfig.tsx": {
      maxLines: 2887,
      reason: "Existing provider, authorization and editor flows; scheduled for 22-08.",
    },
    "src/renderer/components/SessionSidebar.tsx": {
      maxLines: 2767,
      reason: "Existing session list and project operations; 22-04/08 separate their ownership.",
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
      maxLines: 1449,
      reason: "Existing chat presentation after metadata callbacks were removed; keep a fixed ceiling.",
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
    "src/renderer/components/SkillsConfig.tsx": {
      maxLines: 1222,
      reason: "Existing skills configuration UI, close to the default limit.",
    },
    "src/main/toolchains/manager.ts": {
      maxLines: 1219,
      reason: "Existing toolchain installation/validation owner; keep its bounded-operation behavior.",
    },
  },
  dataModules: {
    "src/renderer/i18n-dictionaries.ts": {
      baselineLines: 3549,
      reason:
        "Translation data, checked for literal-only contents here and parity/duplicates/fallbacks by check:i18n; split under 22-08.",
    },
  },
  // An exception, when necessary, must name an exact rule/from/to edge and
  // provide both reason and removeWhen. Wildcards and unused exceptions fail.
  exceptions: [],
};
