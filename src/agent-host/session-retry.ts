import {
  VIRTUAL_MODEL_STATE_ENTRY,
  type CustomEntry,
  type VirtualModelStateData,
} from "@earendil-works/pi-coding-agent";
import { AUTO_ROUTING_MODEL, AUTO_ROUTING_PROVIDER } from "../contract/model-settings";
import type { AgentEvent, SessionRetryInfo } from "../contract/types";
import type { DesktopRouteState } from "./auto-routing";

/** The SDK appends the chosen virtual route after it resolves, including during a session-level retry. */
export function projectSessionRetry(
  current: SessionRetryInfo | null,
  event: AgentEvent,
  failedMessageTimestamp?: number,
): SessionRetryInfo | null {
  switch (event.type) {
    case "auto_retry_start":
      return {
        ...(failedMessageTimestamp !== undefined && { failedMessageTimestamp }),
        attempt: Number(event.attempt),
        maxAttempts: Number(event.maxAttempts),
        errorMessage: event.errorMessage as string | undefined,
      };
    case "auto_retry_end":
    case "prompt_done":
    case "prompt_error":
    case "channel_turn_end":
    case "channel_turn_error":
      return null;
    case "entry_appended": {
      if (!current) return null;
      const entry = event.entry as CustomEntry<VirtualModelStateData<DesktopRouteState>> | undefined;
      const data = entry?.data;
      if (
        entry?.type !== "custom" ||
        entry.customType !== VIRTUAL_MODEL_STATE_ENTRY ||
        data?.provider !== AUTO_ROUTING_PROVIDER ||
        data.modelId !== AUTO_ROUTING_MODEL ||
        data.state?.reason !== "retry"
      )
        return current;
      const { retryFrom, target } = data.state;
      if (
        !retryFrom?.provider ||
        !retryFrom.modelId ||
        !target?.provider ||
        !target.modelId ||
        (retryFrom.provider === target.provider && retryFrom.modelId === target.modelId)
      )
        return current;
      return {
        ...current,
        modelSwitch: { from: `${retryFrom.provider}/${retryFrom.modelId}`, to: `${target.provider}/${target.modelId}` },
      };
    }
    default:
      return current;
  }
}
