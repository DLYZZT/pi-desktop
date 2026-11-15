/**
 * Splits growing Markdown into top-level blocks so a streaming renderer can
 * keep finished blocks memoized and re-parse only the unfinished tail.
 *
 * The split is deliberately conservative. A boundary is a blank line outside
 * fenced code and display math whose following line cannot continue or depend
 * on the previous container (lists, quotes, indented code, tables, link or
 * footnote definitions). Once a raw HTML block appears, the rest stays one
 * block because its element may span blank lines. A fence that opens without
 * indentation is always a top-level block (it cannot be a lazy continuation of
 * a list or quote), so it starts a block and its closing line ends one; a long
 * code block is therefore finished the moment it closes.
 *
 * Joining the returned blocks reproduces the source exactly. The last entry is
 * the unfinished tail and is empty when the source ends right after a closed
 * top-level fence. The settled message is still rendered from the complete
 * source.
 */

/** A tail above this size is shown as plain text until it settles or splits. */
export const STREAMING_TAIL_PARSE_LIMIT = 8 * 1024;

const FENCE_RE = /^[ \t]*(`{3,}|~{3,})(.*)$/;
const CONTINUATION_START_RE = /^(?:[ \t]|[-*+][ \t]|\d{1,9}[.)][ \t]|>|\||\[)/;
const HTML_BLOCK_START_RE = /^ {0,3}<(?:[A-Za-z!?/])/;

function countDisplayMathDelimiters(line: string): number {
  let count = 0;
  for (let index = line.indexOf("$$"); index !== -1; index = line.indexOf("$$", index + 2)) count += 1;
  return count;
}

export function splitStreamingMarkdown(source: string): string[] {
  const blocks: string[] = [];
  let blockStart = 0;
  let cursor = 0;
  let fence: { marker: string; size: number; topLevel: boolean } | null = null;
  let mathOpen = false;
  let sawHtmlBlock = false;
  let blankRunStart = -1;
  let previousLineBlank = true;

  while (cursor < source.length) {
    const newline = source.indexOf("\n", cursor);
    const lineEnd = newline === -1 ? source.length : newline;
    const nextCursor = newline === -1 ? source.length : newline + 1;
    const line =
      source.charCodeAt(lineEnd - 1) === 13 ? source.slice(cursor, lineEnd - 1) : source.slice(cursor, lineEnd);
    const blank = line.trim() === "";

    if (fence) {
      const close = FENCE_RE.exec(line);
      if (close && close[1][0] === fence.marker && close[1].length >= fence.size && close[2].trim() === "") {
        if (fence.topLevel) {
          blocks.push(source.slice(blockStart, nextCursor));
          blockStart = nextCursor;
        }
        fence = null;
      }
      previousLineBlank = false;
    } else if (blank) {
      if (!previousLineBlank) blankRunStart = cursor;
      previousLineBlank = true;
    } else {
      const open = FENCE_RE.exec(line);
      const opensFence = open !== null && !(open[1][0] === "`" && open[2].includes("`"));
      const topLevelFence = opensFence && !mathOpen && !sawHtmlBlock && line[0] !== " " && line[0] !== "\t";
      if (
        cursor > blockStart &&
        (topLevelFence ||
          (previousLineBlank &&
            blankRunStart > blockStart &&
            !mathOpen &&
            !sawHtmlBlock &&
            !CONTINUATION_START_RE.test(line)))
      ) {
        blocks.push(source.slice(blockStart, cursor));
        blockStart = cursor;
      }
      previousLineBlank = false;
      if (open && opensFence) {
        fence = { marker: open[1][0], size: open[1].length, topLevel: topLevelFence };
      } else {
        if (HTML_BLOCK_START_RE.test(line)) sawHtmlBlock = true;
        if (countDisplayMathDelimiters(line) % 2 === 1) mathOpen = !mathOpen;
      }
    }
    cursor = nextCursor;
  }

  blocks.push(source.slice(blockStart));
  return blocks;
}

const LINK_DEFINITION_RE = /^ {0,3}\[((?:[^\]\\]|\\.)+)\]:[ \t]*\S/;

/**
 * Blocks are parsed independently, so a reference such as `[text][label]`
 * cannot see a link definition that lives in another block. Returns, for each
 * block, the definitions from other blocks whose label it mentions, as text to
 * append before parsing (empty when nothing applies). Only single-line link
 * definitions are shared; footnotes resolve when the message settles.
 */
export function resolveStreamingDefinitions(blocks: readonly string[]): string[] {
  const none = blocks.map(() => "");
  if (blocks.length < 2 || !blocks.some((block) => block.includes("]:"))) return none;

  const definitions = new Map<string, { line: string; block: number }>();
  const endsInsideFence: boolean[] = [];
  blocks.forEach((block, blockIndex) => {
    let fence: { marker: string; size: number } | null = null;
    let canStartDefinition = true;
    for (const rawLine of block.split("\n")) {
      const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
      const fenceMatch = FENCE_RE.exec(line);
      if (fence) {
        if (
          fenceMatch &&
          fenceMatch[1][0] === fence.marker &&
          fenceMatch[1].length >= fence.size &&
          fenceMatch[2].trim() === ""
        )
          fence = null;
        canStartDefinition = true;
        continue;
      }
      if (fenceMatch && !(fenceMatch[1][0] === "`" && fenceMatch[2].includes("`"))) {
        fence = { marker: fenceMatch[1][0], size: fenceMatch[1].length };
        continue;
      }
      const definition = canStartDefinition ? LINK_DEFINITION_RE.exec(line) : null;
      if (definition && !definition[1].startsWith("^")) {
        const label = definition[1].trim().toLowerCase();
        if (label && !definitions.has(label)) definitions.set(label, { line: line.trim(), block: blockIndex });
      } else {
        // A definition cannot interrupt a paragraph.
        canStartDefinition = line.trim() === "";
      }
    }
    endsInsideFence.push(fence !== null);
  });
  if (definitions.size === 0) return none;

  return blocks.map((block, blockIndex) => {
    if (endsInsideFence[blockIndex] || !block.includes("[")) return "";
    const lowered = block.toLowerCase();
    const lines: string[] = [];
    for (const [label, definition] of definitions) {
      if (definition.block !== blockIndex && lowered.includes(`[${label}]`)) lines.push(definition.line);
    }
    return lines.length > 0 ? `\n\n${lines.join("\n")}\n` : "";
  });
}

/**
 * Recognises a tail that is only an unfinished top-level code fence, so it can
 * be rendered as a code block without running the Markdown parser.
 */
export function parseOpenFenceTail(block: string): { lang: string; code: string } | null {
  const newline = block.indexOf("\n");
  if (newline === -1) return null;
  const firstLine = block.slice(0, newline).replace(/\r$/, "");
  const open = /^(`{3,}|~{3,})[ \t]*([^\s`]*)[^`]*$/.exec(firstLine);
  if (!open) return null;
  const marker = open[1][0];
  const size = open[1].length;
  const body = block.slice(newline + 1);
  for (const line of body.split("\n")) {
    const close = FENCE_RE.exec(line.replace(/\r$/, ""));
    if (close && close[1][0] === marker && close[1].length >= size && close[2].trim() === "") return null;
  }
  return { lang: open[2].toLowerCase(), code: body.replace(/\r\n/g, "\n").replace(/\n$/, "") };
}
