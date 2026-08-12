export const MAX_DIFF_INPUT_BYTES = 384 * 1024;
export const MAX_DIFF_LINES_PER_SIDE = 12_000;
export const MAX_DIFF_COMBINED_LINES = 16_000;
export const MAX_DIFF_EDIT_DISTANCE = 1_200;
export const MAX_DIFF_TRACE_CELLS = 2_000_000;

export type DiffLine =
  | { type: "unchanged"; text: string; lineNo: number }
  | { type: "removed"; text: string; lineNo: number }
  | { type: "added"; text: string; lineNo: number };

export type TextDiffResult =
  | { kind: "lines"; lines: DiffLine[] }
  | { kind: "fallback"; reason: "bytes" | "lines" | "edit-distance" | "trace"; oldLines: number; newLines: number };

type FallbackReason = Extract<TextDiffResult, { kind: "fallback" }>["reason"];

function lineCount(content: string): number {
  let count = 1;
  for (let i = 0; i < content.length; i += 1) {
    if (content.charCodeAt(i) === 10) count += 1;
  }
  return count;
}

function utf8Bytes(content: string): number {
  return new TextEncoder().encode(content).byteLength;
}

function fallback(reason: FallbackReason, oldLines: number, newLines: number): TextDiffResult {
  return { kind: "fallback", reason, oldLines, newLines };
}

export function createBoundedTextDiff(oldContent: string, newContent: string): TextDiffResult {
  if (oldContent === newContent) {
    return {
      kind: "lines",
      lines: oldContent.split("\n").map((text, index) => ({ type: "unchanged", text, lineNo: index + 1 })),
    };
  }

  const oldLineCount = lineCount(oldContent);
  const newLineCount = lineCount(newContent);
  if (utf8Bytes(oldContent) + utf8Bytes(newContent) > MAX_DIFF_INPUT_BYTES) {
    return fallback("bytes", oldLineCount, newLineCount);
  }
  if (
    oldLineCount > MAX_DIFF_LINES_PER_SIDE ||
    newLineCount > MAX_DIFF_LINES_PER_SIDE ||
    oldLineCount + newLineCount > MAX_DIFF_COMBINED_LINES
  ) {
    return fallback("lines", oldLineCount, newLineCount);
  }

  const oldLines = oldContent.split("\n");
  const newLines = newContent.split("\n");
  let prefix = 0;
  while (prefix < oldLines.length && prefix < newLines.length && oldLines[prefix] === newLines[prefix]) prefix += 1;

  let suffix = 0;
  while (
    suffix < oldLines.length - prefix &&
    suffix < newLines.length - prefix &&
    oldLines[oldLines.length - 1 - suffix] === newLines[newLines.length - 1 - suffix]
  ) {
    suffix += 1;
  }

  const oldCore = oldLines.slice(prefix, oldLines.length - suffix);
  const newCore = newLines.slice(prefix, newLines.length - suffix);
  const estimatedEditDistance = oldCore.length + newCore.length;
  if (estimatedEditDistance > MAX_DIFF_EDIT_DISTANCE) {
    return fallback("edit-distance", oldLineCount, newLineCount);
  }

  const projectedTraceCells = (2 * estimatedEditDistance + 1) * (estimatedEditDistance + 1);
  if (projectedTraceCells > MAX_DIFF_TRACE_CELLS) {
    return fallback("trace", oldLineCount, newLineCount);
  }

  const lines: DiffLine[] = [];
  for (let i = 0; i < prefix; i += 1) {
    lines.push({ type: "unchanged", text: oldLines[i], lineNo: i + 1 });
  }
  lines.push(...normalizeReplacementOrder(myersDiff(oldCore, newCore, prefix)));
  for (let i = oldLines.length - suffix; i < oldLines.length; i += 1) {
    lines.push({ type: "unchanged", text: oldLines[i], lineNo: i + 1 });
  }
  return { kind: "lines", lines };
}

function normalizeReplacementOrder(lines: DiffLine[]): DiffLine[] {
  const normalized: DiffLine[] = [];
  let index = 0;
  while (index < lines.length) {
    if (lines[index]?.type !== "added") {
      normalized.push(lines[index]);
      index += 1;
      continue;
    }
    const additions: DiffLine[] = [];
    while (lines[index]?.type === "added") additions.push(lines[index++]);
    const removals: DiffLine[] = [];
    while (lines[index]?.type === "removed") removals.push(lines[index++]);
    normalized.push(...removals, ...additions);
  }
  return normalized;
}

function myersDiff(oldLines: string[], newLines: string[], oldLineOffset: number): DiffLine[] {
  const m = oldLines.length;
  const n = newLines.length;
  const max = m + n;
  if (max === 0) return [];
  const offset = max;
  const v: number[] = new Array(2 * max + 1).fill(0);
  const trace: number[][] = [];

  for (let d = 0; d <= max; d += 1) {
    trace.push([...v]);
    for (let k = -d; k <= d; k += 2) {
      let x: number;
      if (k === -d || (k !== d && v[k - 1 + offset] < v[k + 1 + offset])) x = v[k + 1 + offset];
      else x = v[k - 1 + offset] + 1;
      let y = x - k;
      while (x < m && y < n && oldLines[x] === newLines[y]) {
        x += 1;
        y += 1;
      }
      v[k + offset] = x;
      if (x >= m && y >= n) return backtrack(trace, oldLines, newLines, d, offset, oldLineOffset);
    }
  }
  return [];
}

function backtrack(
  trace: number[][],
  oldLines: string[],
  newLines: string[],
  distance: number,
  offset: number,
  oldLineOffset: number,
): DiffLine[] {
  const reversed: DiffLine[] = [];
  let x = oldLines.length;
  let y = newLines.length;
  for (let d = distance; d > 0; d -= 1) {
    // trace is captured before each distance is processed, so trace[d]
    // contains the completed frontier for distance d - 1.
    const previous = trace[d];
    const k = x - y;
    const previousK = k === -d || (k !== d && previous[k - 1 + offset] < previous[k + 1 + offset]) ? k + 1 : k - 1;
    const previousX = previous[previousK + offset];
    const previousY = previousX - previousK;
    while (x > previousX && y > previousY) {
      x -= 1;
      y -= 1;
      reversed.push({ type: "unchanged", text: oldLines[x], lineNo: oldLineOffset + x + 1 });
    }
    if (x > previousX) {
      x -= 1;
      reversed.push({ type: "removed", text: oldLines[x], lineNo: oldLineOffset + x + 1 });
    } else {
      y -= 1;
      reversed.push({ type: "added", text: newLines[y], lineNo: y + 1 });
    }
  }
  while (x > 0 && y > 0) {
    x -= 1;
    y -= 1;
    reversed.push({ type: "unchanged", text: oldLines[x], lineNo: oldLineOffset + x + 1 });
  }
  return reversed.reverse();
}
