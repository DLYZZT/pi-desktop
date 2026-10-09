import type { InlineExtension } from "@earendil-works/pi-coding-agent";

const SETTLEMENT_ENTRY = "pi-desktop-agent-settled";
type Entry = { id: string; type: string; customType?: string; data?: unknown };

/** Record the SDK's authoritative cancellation without rewriting the original assistant message. */
export function createAgentSettlementExtension(): InlineExtension {
  return {
    name: "pi-desktop-agent-settlement",
    hidden: true,
    factory: (pi) => {
      let startLeaf: string | null | undefined;
      pi.on("agent_start", (_event, ctx) => {
        startLeaf = ctx.sessionManager.getLeafId();
      });
      pi.on("agent_settled", (event, ctx) => {
        const leaf = startLeaf;
        startLeaf = undefined;
        if (!event.aborted || leaf === undefined) return;
        const branch = ctx.sessionManager.getBranch();
        const start = leaf === null ? -1 : branch.findIndex((entry) => entry.id === leaf);
        if (leaf !== null && start < 0) return;
        const assistant = branch
          .slice(start + 1)
          .findLast((entry) => entry.type === "message" && entry.message.role === "assistant");
        if (assistant) pi.appendEntry(SETTLEMENT_ENTRY, { version: 1, aborted: true, assistantEntryId: assistant.id });
      });
    },
  };
}

/** Only markers on this selected branch may annotate preceding messages on that branch. */
export function abortedAssistantEntryIds(entries: readonly Entry[]): Set<string> {
  const seen = new Set<string>();
  const aborted = new Set<string>();
  for (const entry of entries) {
    if (entry.type === "message") seen.add(entry.id);
    if (
      entry.type !== "custom" ||
      entry.customType !== SETTLEMENT_ENTRY ||
      !entry.data ||
      typeof entry.data !== "object"
    )
      continue;
    const data = entry.data as { version?: unknown; aborted?: unknown; assistantEntryId?: unknown };
    if (
      data.version === 1 &&
      data.aborted === true &&
      typeof data.assistantEntryId === "string" &&
      seen.has(data.assistantEntryId)
    )
      aborted.add(data.assistantEntryId);
  }
  return aborted;
}
