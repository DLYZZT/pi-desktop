export type SplitDiffCellType = "context" | "removed" | "added" | "empty";

export interface SplitDiffCell {
  lineNo: number | null;
  text: string;
  type: SplitDiffCellType;
}

export type SplitDiffRow = { type: "hunk"; text: string } | { type: "line"; left: SplitDiffCell; right: SplitDiffCell };

export interface SplitDiffFile {
  oldPath?: string;
  newPath?: string;
  rows: SplitDiffRow[];
}

interface PendingChangeLine {
  lineNo: number;
  text: string;
}

interface HunkState {
  oldRemaining: number;
  newRemaining: number;
}

export function parseUnifiedPatch(text: string): SplitDiffFile[] | null {
  const files: SplitDiffFile[] = [];
  let current: SplitDiffFile | null = null;
  let pendingOldPath: string | undefined;
  let oldLineNo = 0;
  let newLineNo = 0;
  let hunkState: HunkState | null = null;
  let removed: PendingChangeLine[] = [];
  let added: PendingChangeLine[] = [];

  const emptyCell = (): SplitDiffCell => ({ lineNo: null, text: "", type: "empty" });
  const flushChanges = () => {
    if (!current) {
      removed = [];
      added = [];
      return;
    }
    const count = Math.max(removed.length, added.length);
    for (let i = 0; i < count; i++) {
      const left = removed[i]
        ? { lineNo: removed[i].lineNo, text: removed[i].text, type: "removed" as const }
        : emptyCell();
      const right = added[i] ? { lineNo: added[i].lineNo, text: added[i].text, type: "added" as const } : emptyCell();
      current.rows.push({ type: "line", left, right });
    }
    removed = [];
    added = [];
  };

  const finishHunkIfComplete = () => {
    if (hunkState?.oldRemaining === 0 && hunkState.newRemaining === 0) {
      flushChanges();
      hunkState = null;
    }
  };

  for (const line of text.split(/\r?\n/)) {
    if (hunkState) {
      if (line === "\\ No newline at end of file") {
        flushChanges();
        current?.rows.push({ type: "hunk", text: line });
        continue;
      }

      const prefix = line[0];
      const content = line.slice(1);
      if (prefix === " " && hunkState.oldRemaining > 0 && hunkState.newRemaining > 0) {
        flushChanges();
        current?.rows.push({
          type: "line",
          left: { lineNo: oldLineNo++, text: content, type: "context" },
          right: { lineNo: newLineNo++, text: content, type: "context" },
        });
        hunkState.oldRemaining--;
        hunkState.newRemaining--;
      } else if (prefix === "-" && hunkState.oldRemaining > 0) {
        removed.push({ lineNo: oldLineNo++, text: content });
        hunkState.oldRemaining--;
      } else if (prefix === "+" && hunkState.newRemaining > 0) {
        added.push({ lineNo: newLineNo++, text: content });
        hunkState.newRemaining--;
      } else {
        return null;
      }
      finishHunkIfComplete();
      continue;
    }

    if (line === "\\ No newline at end of file" && current) {
      current.rows.push({ type: "hunk", text: line });
      continue;
    }

    if (line.startsWith("--- ")) {
      flushChanges();
      pendingOldPath = cleanPatchPath(line.slice(4));
      continue;
    }

    if (line.startsWith("+++ ")) {
      if (pendingOldPath === undefined) return null;
      flushChanges();
      current = { oldPath: pendingOldPath, newPath: cleanPatchPath(line.slice(4)), rows: [] };
      pendingOldPath = undefined;
      files.push(current);
      continue;
    }

    const hunk = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(?:.*)?$/);
    if (hunk) {
      if (!current) {
        current = { rows: [] };
        files.push(current);
      }
      flushChanges();
      oldLineNo = Number(hunk[1]);
      newLineNo = Number(hunk[3]);
      hunkState = {
        oldRemaining: hunk[2] === undefined ? 1 : Number(hunk[2]),
        newRemaining: hunk[4] === undefined ? 1 : Number(hunk[4]),
      };
      current.rows.push({ type: "hunk", text: line });
      finishHunkIfComplete();
      continue;
    }

    if (line.startsWith("@@")) return null;
  }

  if (hunkState || pendingOldPath !== undefined) return null;
  flushChanges();

  const parsed = files.filter((file) => file.rows.some((row) => row.type === "line"));
  return parsed.length > 0 ? parsed : null;
}

function cleanPatchPath(path: string): string {
  return path.split("\t")[0].trim();
}
