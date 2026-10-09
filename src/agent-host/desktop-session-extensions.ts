import type { InlineExtension } from "@earendil-works/pi-coding-agent";
import { createDesktopPromptExtension } from "./session-prompt-policy";
import type { SessionPromptPolicy } from "./session-prompt-policy";
import type { SessionToolPolicy } from "./session-tool-policy";
import type { SessionExecutionHistory } from "./session-execution-history";
import { createLegacyChannelContextExtension } from "./legacy-channel-context";
import { desktopMcpExtensions } from "./mcp/extensions";
import { sessionOrchestrationExtensions } from "./session-orchestration";
import { createAgentSettlementExtension } from "./agent-settlement";

export function desktopSessionExtensions(
  policy: SessionToolPolicy,
  history: SessionExecutionHistory,
  prompt: SessionPromptPolicy,
  running: () => boolean,
): InlineExtension[] {
  return [
    createAgentSettlementExtension(),
    policy.extension(),
    history.extension(),
    ...sessionOrchestrationExtensions(undefined, { isAllowed: () => policy.isAllowed("codemode"), history }),
    ...desktopMcpExtensions(policy, running, history),
    createLegacyChannelContextExtension(),
    createDesktopPromptExtension(prompt),
  ];
}
