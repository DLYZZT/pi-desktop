export function parseChromeModel(model: string | null): { provider: string; id: string } | null {
  if (!model) return null;
  const match = /^\(([^)]+)\)\s+(\S+)/.exec(model.trim());
  return match ? { provider: match[1], id: match[2] } : null;
}

export function thinkingCycleSteps(from: string, to: string, levels: readonly string[]): number {
  if (from === to || levels.length === 0) return 0;
  const start = levels.indexOf(from);
  const end = levels.indexOf(to);
  if (start < 0 || end < 0) return 0;
  return (end - start + levels.length) % levels.length;
}

export function folderLabel(cwd: string): string {
  const parts = cwd.replace(/[\\/]+$/, "").split(/[\\/]/);
  return parts[parts.length - 1] || cwd;
}

export type DockRowRange = {
  start: number;
  end: number;
};

export type DockCssRect = {
  left: number;
  top: number;
  width: number;
  height: number;
};

export type DockChrome = {
  path: string | null;
  usage: string | null;
  model: string | null;
  thinking: string | null;
  statuses: string[];
};

export const EMPTY_DOCK_CHROME: DockChrome = {
  path: null,
  usage: null,
  model: null,
  thinking: null,
  statuses: [],
};

const DOCK_CHROME = /MCP:|SuperGrok|PR #\d+|↑|↓|\$\d|\(\s*sub\s*\)|CH\d|\/\d+k|\(\w[\w./-]*\)\s*$/i;

const SPINNER = /[\u280B\u2819\u2839\u2838\u283C\u2826\u2827\u2807\u280F\u281F]/;

export function lineLooksLikeDockBorder(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length < 8) return false;
  let box = 0;
  for (const ch of trimmed) {
    if (ch === "\u2500" || ch === "\u2501" || ch === "\u2550" || ch === "-" || ch === "=") box += 1;
  }
  return box / trimmed.length >= 0.6;
}

export function lineLooksLikeLiveStatus(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;
  if (SPINNER.test(trimmed[0] ?? "")) return true;
  return /^(Working|Thinking|Compacting)\b/i.test(trimmed);
}

export function screenHasLiveStatus(lines: string[]): boolean {
  return lines.some((line) => lineLooksLikeLiveStatus(line));
}

export function lineLooksLikeDockChrome(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed || lineLooksLikeLiveStatus(trimmed)) return false;
  if (lineLooksLikeDockBorder(trimmed)) return true;
  if (DOCK_CHROME.test(trimmed)) return true;
  if (
    (/^[A-Za-z]:[\\/]/.test(trimmed) || trimmed.startsWith("~/") || trimmed.startsWith("/")) &&
    trimmed.length < 220
  ) {
    return true;
  }
  return false;
}

export function findDockRowRange(lines: string[]): DockRowRange | null {
  if (lines.length === 0) return null;

  let end = lines.length - 1;
  while (end > 0 && !lines[end].trim()) end -= 1;
  if (!lines[end]?.trim()) return null;

  const borders: number[] = [];
  for (let y = 0; y <= end; y += 1) {
    if (lineLooksLikeDockBorder(lines[y] ?? "")) borders.push(y);
  }
  const lastBorder = borders[borders.length - 1];
  const dockBorders = lastBorder === undefined ? [] : borders.filter((y) => lastBorder - y <= 8);

  let start: number;
  if (dockBorders.length > 0) {
    start = dockBorders[0];
    end = Math.max(end, dockBorders[dockBorders.length - 1]);
  } else {
    start = end;
    while (start > 0 && lineLooksLikeDockChrome(lines[start] ?? "")) start -= 1;
    if (!lineLooksLikeDockChrome(lines[start] ?? "")) start += 1;
    if (start > end) return null;
    if (start > 0 && lineLooksLikeDockChrome(lines[start - 1] ?? "")) start -= 1;
  }

  while (start > 0) {
    const above = lines[start - 1] ?? "";
    if (lineLooksLikeLiveStatus(above)) break;
    if (lineLooksLikeDockChrome(above)) {
      start -= 1;
      continue;
    }
    if (!above.trim() && start > 1 && lineLooksLikeDockChrome(lines[start - 2] ?? "")) {
      start -= 1;
      continue;
    }
    break;
  }

  return start <= end ? { start, end } : null;
}

function parseStatuses(line: string): string[] {
  const statuses: string[] = [];
  const pr = line.match(/PR\s+#\d+:\s*.+?(?=\s*(?:🔌|MCP:|SuperGrok)|$)/i);
  if (pr) statuses.push(pr[0].replace(/🔌/g, "").trim());
  const mcp = line.match(/MCP:\s*.+?(?=\s*SuperGrok|$)/i);
  if (mcp) statuses.push(mcp[0].trim());
  const grok = line.match(/SuperGrok\s+.+$/i);
  if (grok) statuses.push(grok[0].trim());
  return statuses;
}

function parseUsageModelThinking(line: string): Pick<DockChrome, "usage" | "model" | "thinking"> {
  const modelHit = line.match(/\(([^)]+)\)\s+(\S+)\s+•\s+(\S+)\s*$/);
  let usage = line.trim();
  let model: string | null = null;
  let thinking: string | null = null;
  if (modelHit && modelHit.index !== undefined) {
    model = `(${modelHit[1]}) ${modelHit[2]}`;
    thinking = modelHit[3];
    usage = line.slice(0, modelHit.index).trim();
  }
  const trailing = usage.match(/\((auto|off|minimal|low|medium|high|xhigh)\)\s*$/i);
  if (trailing && trailing.index !== undefined) {
    if (!thinking) thinking = trailing[1];
    usage = usage.slice(0, trailing.index).trim();
  }
  return { usage: usage || null, model, thinking };
}

export function parseDockChrome(lines: string[]): DockChrome {
  const slice = lines.slice(-8);
  const chrome: DockChrome = { ...EMPTY_DOCK_CHROME, statuses: [] };
  for (const raw of slice) {
    const line = raw.trim();
    if (!line || lineLooksLikeDockBorder(line) || lineLooksLikeLiveStatus(line)) continue;
    if (!chrome.path && (/^[A-Za-z]:[\\/]/.test(line) || line.startsWith("~/") || line.startsWith("/"))) {
      chrome.path = line;
      continue;
    }
    const statuses = parseStatuses(line);
    if (statuses.length > 0) {
      chrome.statuses.push(...statuses);
      continue;
    }
    if (/[↑↓]|\$\d|\d+%\/\d/.test(line)) {
      const parsed = parseUsageModelThinking(line);
      chrome.usage = parsed.usage;
      chrome.model = parsed.model;
      chrome.thinking = parsed.thinking;
    }
  }
  return chrome;
}

export function sameDockChrome(a: DockChrome, b: DockChrome): boolean {
  return (
    a.path === b.path &&
    a.usage === b.usage &&
    a.model === b.model &&
    a.thinking === b.thinking &&
    a.statuses.length === b.statuses.length &&
    a.statuses.every((item, index) => item === b.statuses[index])
  );
}

export function dockRangeToCssRect(
  range: DockRowRange,
  screen: DockCssRect,
  root: Pick<DockCssRect, "left" | "top">,
  cols: number,
  rows: number,
  pad = 6,
): DockCssRect | null {
  if (cols <= 0 || rows <= 0 || screen.width <= 0 || screen.height <= 0) return null;
  const cellHeight = screen.height / rows;
  return {
    left: screen.left - root.left - pad,
    top: screen.top - root.top + range.start * cellHeight - pad,
    width: screen.width + pad * 2,
    height: (range.end - range.start + 1) * cellHeight + pad * 2,
  };
}
