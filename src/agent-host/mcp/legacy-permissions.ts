import type { SessionExecutionHistory } from "../session-execution-history";
import { legacyMcpIdentityEvidence } from "./tool-names";

/** Combine native direct results with Desktop's durable nested results, without repairing either log. */
export async function readLegacyMcpEvidence(
  nativeEntries: readonly unknown[],
  toolNames: readonly string[],
  updatedAt?: string,
  history?: Pick<SessionExecutionHistory, "store">,
): Promise<Record<string, string>> {
  if (!toolNames.length) return {};
  const selected = new Set(toolNames),
    entries = [...nativeEntries],
    uncertain = new Set<string>();
  if (history) {
    try {
      const page = await history.store.readLatest(
        { limit: 10000, includeContent: true, maxContentBytes: 2097152 },
        undefined,
        { toolNames: selected, project: true },
      );
      if (!page.complete || page.truncatedTail) return {};
      for (const record of page.records) {
        if (record.status === "blocked" || record.status === "requested") continue;
        const result = record.result?.value as { details?: unknown } | undefined;
        if (!record.result?.complete || !result?.details) {
          uncertain.add(record.toolName);
          continue;
        }
        entries.push({
          type: "message",
          timestamp: new Date(record.endedAt ?? record.startedAt ?? record.requestedAt).toISOString(),
          message: { role: "toolResult", toolName: record.toolName, details: result.details },
        });
      }
    } catch {
      // Missing/unreadable identity evidence must never prevent startup or manufacture a grant.
      return {};
    }
  }
  return Object.fromEntries(
    Object.entries(legacyMcpIdentityEvidence(entries, updatedAt)).filter(
      ([name]) => selected.has(name) && !uncertain.has(name),
    ),
  );
}
