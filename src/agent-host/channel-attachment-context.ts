import type { SessionManager } from "@earendil-works/pi-coding-agent";
import type { AgentSessionLike } from "../shared/pi-types";

function lastAssistantId(manager: SessionManager): string | undefined {
  return manager.getBranch().findLast((entry) => entry.type === "message" && entry.message.role === "assistant")?.id;
}

export async function promptChannelTurn(
  session: AgentSessionLike,
  params: {
    runId: string;
    message: string;
    attachmentContext?: string;
    images?: Array<{ type: "image"; data: string; mimeType: string }>;
  },
): Promise<{ preflight: "started" | "queued" | "handled" | undefined; finalText: string }> {
  const previousAssistant = lastAssistantId(session.sessionManager);
  if (params.attachmentContext)
    await session.sendCustomMessage(
      {
        customType: "pi-desktop-channel-attachment-context",
        content: params.attachmentContext,
        display: false,
        details: { channelRunId: params.runId },
      },
      { deliverAs: "nextTurn" },
    );
  let preflight: "started" | "queued" | "handled" | undefined;
  try {
    await session.prompt(params.message, {
      ...(params.images?.length ? { images: params.images } : {}),
      expandPromptTemplates: false,
      source: "rpc",
      preflightResult: (result) => {
        preflight = result;
      },
    });
  } finally {
    // pi.sendMessage(triggerTurn) is fire-and-forget. Retain ownership even if prompt() then rejects.
    if (session.isStreaming || session.isCompacting) await session.waitForIdle();
  }
  // Input hooks may handle a message without producing a response, or run their own new response.
  const stale = preflight === "handled" && lastAssistantId(session.sessionManager) === previousAssistant;
  return { preflight, finalText: stale ? "" : (session.getLastAssistantText()?.trim() ?? "") };
}

export function cancelChannelAttachmentContext(manager: SessionManager, runId: string, hasAttachment: boolean): void {
  const persisted = manager
    .getBranch()
    .some(
      (entry) =>
        entry.type === "message" &&
        entry.message.role === "custom" &&
        entry.message.customType === "pi-desktop-channel-attachment-context" &&
        (entry.message.details as { channelRunId?: unknown } | undefined)?.channelRunId === runId,
    );
  manager.appendCustomEntry("pi-desktop-channel-source-cancelled", {
    runId,
    discardAttachmentContext: hasAttachment && !persisted,
  });
}
