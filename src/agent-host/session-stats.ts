import type { SessionStatsInfo } from "../shared/pi-types.ts";
import type { SessionEntry, Usage } from "../shared/types.ts";

type StatsOptions = {
  sessionId: string;
  sessionFile?: string;
  sessionName?: string;
  contextUsage?: SessionStatsInfo["contextUsage"];
};

/** Read-only equivalent of Pi's all-entry usage totals, with Desktop chat counts. */
export function buildSessionStats(entries: readonly SessionEntry[], options: StatsOptions): SessionStatsInfo {
  const tokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
  let cost = 0;
  let userMessages = 0;
  let assistantMessages = 0;
  let toolResults = 0;
  let toolCalls = 0;

  function includeUsage(usage?: Usage): void {
    if (!usage) return;
    tokens.input += usage.input;
    tokens.output += usage.output;
    tokens.cacheRead += usage.cacheRead;
    tokens.cacheWrite += usage.cacheWrite;
    cost += usage.cost.total;
  }

  for (const entry of entries) {
    if (entry.type === "usage") {
      includeUsage(entry.usage);
      continue;
    }
    if (entry.type === "compaction" || entry.type === "branch_summary") {
      includeUsage(entry.usage);
      continue;
    }
    if (entry.type !== "message") continue;
    const message = entry.message;
    if (message.role === "user") userMessages++;
    else if (message.role === "toolResult") {
      toolResults++;
      includeUsage(message.usage);
    } else if (message.role === "assistant") {
      assistantMessages++;
      toolCalls += message.content.filter((block) => block.type === "toolCall").length;
      includeUsage(message.usage);
    }
  }
  tokens.total = tokens.input + tokens.output + tokens.cacheRead + tokens.cacheWrite;
  return {
    sessionId: options.sessionId,
    ...(options.sessionFile ? { sessionFile: options.sessionFile } : {}),
    ...(options.sessionName ? { sessionName: options.sessionName } : {}),
    ...(options.contextUsage ? { contextUsage: options.contextUsage } : {}),
    userMessages,
    assistantMessages,
    toolResults,
    toolCalls,
    totalMessages: userMessages + assistantMessages + toolResults,
    tokens,
    cost,
  };
}
