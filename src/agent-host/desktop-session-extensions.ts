import type { InlineExtension } from "@earendil-works/pi-coding-agent";
import { createDesktopPromptExtension } from "./session-prompt-policy";
import type { SessionPromptPolicy } from "./session-prompt-policy";
import type { SessionToolPolicy } from "./session-tool-policy";
import type { SessionExecutionHistory } from "./session-execution-history";
import { createLegacyChannelContextExtension } from "./legacy-channel-context";
import { desktopMcpExtensions } from "./mcp/extensions";

export function desktopSessionExtensions(
  policy: SessionToolPolicy,
  history: SessionExecutionHistory,
  prompt: SessionPromptPolicy,
  running: () => boolean,
): InlineExtension[] {
  return [
    policy.extension(),
    history.extension(),
    ...desktopMcpExtensions(policy, running),
    createLegacyChannelContextExtension(),
    createDesktopPromptExtension(prompt),
  ];
}
