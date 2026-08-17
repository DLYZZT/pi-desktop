const MODES = new Set(["single", "parallel", "chain"]);
const COLLAPSED_ITEM_COUNT = 10;

export type TrailMark = "live" | "done" | "fail";

export type TrailItem = { type: "text"; text: string } | { type: "toolCall"; name: string; preview: string };

export type TrailRow = {
  agent: string;
  mark: TrailMark;
  step?: number;
  items: TrailItem[];
  collapsedItems: TrailItem[];
  usage?: string;
  finalText?: string;
  errorMessage?: string;
};

export type SubagentTrail = {
  mode: "single" | "parallel" | "chain";
  live: boolean;
  mark: TrailMark;
  header?: string;
  rows: TrailRow[];
};

export function parseSubagentTrail(details: unknown, live: boolean): SubagentTrail | null {
  if (!isRecord(details)) return null;
  const mode = details.mode;
  if (typeof mode !== "string" || !MODES.has(mode)) return null;
  if (!Array.isArray(details.results)) return null;

  const rows = details.results.map((entry) => parseRow(entry, mode, live));
  const header = mode === "single" ? undefined : formatHeader(mode, rows, live);
  return {
    mode: mode as SubagentTrail["mode"],
    live,
    mark: aggregateMark(rows, live),
    header,
    rows,
  };
}

function parseRow(entry: unknown, mode: string, live: boolean): TrailRow {
  const record = isRecord(entry) ? entry : {};
  const items = getDisplayItems(record.messages);
  const failed = isFailedResult(record);
  const agent = typeof record.agent === "string" && record.agent ? record.agent : "unknown";
  const usage = formatUsage(record.usage, typeof record.model === "string" ? record.model : undefined);
  return {
    agent,
    mark: rowMark(mode, record, live, failed),
    step: typeof record.step === "number" ? record.step : undefined,
    items,
    collapsedItems: items.slice(-COLLAPSED_ITEM_COUNT),
    usage,
    finalText: lastText(items),
    errorMessage: typeof record.errorMessage === "string" ? record.errorMessage : undefined,
  };
}

function rowMark(mode: string, record: Record<string, unknown>, live: boolean, failed: boolean): TrailMark {
  if (failed) return "fail";
  if (!live) return "done";
  if (record.exitCode === -1) return "live";
  // Single-mode live updates keep exitCode 0 until the process closes.
  if (mode === "single") return "live";
  return "done";
}

function aggregateMark(rows: TrailRow[], live: boolean): TrailMark {
  if (live && rows.some((row) => row.mark === "live")) return "live";
  if (rows.some((row) => row.mark === "fail")) return "fail";
  if (rows.length === 0 && live) return "live";
  return "done";
}

function formatHeader(mode: string, rows: TrailRow[], live: boolean): string | undefined {
  if (rows.length === 0) return undefined;
  const running = rows.filter((row) => row.mark === "live").length;
  const done = rows.length - running;
  if (live && running > 0) return `${done}/${rows.length} done, ${running} running`;
  if (mode === "chain") return `${done}/${rows.length} steps`;
  return `${done}/${rows.length} tasks`;
}

function isFailedResult(record: Record<string, unknown>): boolean {
  const exitCode = record.exitCode;
  if (typeof exitCode === "number" && exitCode !== 0 && exitCode !== -1) return true;
  return record.stopReason === "error" || record.stopReason === "aborted";
}

function getDisplayItems(messages: unknown): TrailItem[] {
  if (!Array.isArray(messages)) return [];
  const items: TrailItem[] = [];
  for (const message of messages) {
    if (!isRecord(message) || message.role !== "assistant" || !Array.isArray(message.content)) continue;
    for (const part of message.content) {
      if (!isRecord(part)) continue;
      if (part.type === "text" && typeof part.text === "string") {
        items.push({ type: "text", text: part.text });
        continue;
      }
      if (part.type === "toolCall") {
        const name =
          (typeof part.name === "string" && part.name) ||
          (typeof part.toolName === "string" && part.toolName) ||
          "tool";
        const args = isRecord(part.arguments) ? part.arguments : isRecord(part.input) ? part.input : {};
        items.push({ type: "toolCall", name, preview: previewArgs(args) });
      }
    }
  }
  return items;
}

function lastText(items: TrailItem[]): string | undefined {
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i];
    if (item.type === "text" && item.text.trim()) return item.text;
  }
  return undefined;
}

function formatUsage(usage: unknown, model?: string): string | undefined {
  if (!isRecord(usage)) return undefined;
  const parts: string[] = [];
  if (typeof usage.turns === "number" && usage.turns) parts.push(`${usage.turns} turn${usage.turns > 1 ? "s" : ""}`);
  if (typeof usage.input === "number" && usage.input) parts.push(`↑${formatTokens(usage.input)}`);
  if (typeof usage.output === "number" && usage.output) parts.push(`↓${formatTokens(usage.output)}`);
  if (typeof usage.cacheRead === "number" && usage.cacheRead) parts.push(`R${formatTokens(usage.cacheRead)}`);
  if (typeof usage.cacheWrite === "number" && usage.cacheWrite) parts.push(`W${formatTokens(usage.cacheWrite)}`);
  if (typeof usage.cost === "number" && usage.cost) parts.push(`$${usage.cost.toFixed(4)}`);
  if (model) parts.push(model);
  return parts.length > 0 ? parts.join(" ") : undefined;
}

function formatTokens(count: number): string {
  if (count < 1000) return count.toString();
  if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
  if (count < 1000000) return `${Math.round(count / 1000)}k`;
  return `${(count / 1000000).toFixed(1)}M`;
}

function previewArgs(args: Record<string, unknown>): string {
  if (typeof args.command === "string") return args.command.slice(0, 80);
  if (typeof args.pattern === "string") return args.pattern.slice(0, 80);
  if (typeof args.path === "string") return args.path.slice(0, 80);
  if (typeof args.file_path === "string") return args.file_path.slice(0, 80);
  const first = Object.values(args)[0];
  return first === undefined ? "" : String(first).slice(0, 80);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
