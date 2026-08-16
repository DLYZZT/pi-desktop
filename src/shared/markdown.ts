import type { Options as ReactMarkdownOptions } from "react-markdown";
import rehypeKatex from "rehype-katex";
import rehypeRaw from "rehype-raw";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";

export const markdownSanitizeSchema = {
  ...defaultSchema,
  attributes: {
    ...defaultSchema.attributes,
    code: [["className", /^language-./, "math-inline", "math-display"]],
  },
  protocols: {
    ...defaultSchema.protocols,
    // file: links (attachments, agent-printed paths) must keep their href —
    // otherwise sanitize strips it and the link renders as dead text.
    href: [...(defaultSchema.protocols?.href ?? []), "file"],
  },
  strip: [...(defaultSchema.strip || []), "iframe", "object", "style", "form"],
};

// ---------------------------------------------------------------------------
// Autolink bare paths / URLs in prose so they render as clickable links:
//   file:///C:/x/y     → file link
//   C:\Users\me\a.exe  → file link
//   /home/me/file.txt    → file link
//   https://... / http://... → web link
// The MarkdownBody <a> renderer turns file links into "open in editor/explorer".
// ---------------------------------------------------------------------------

// Path segment: anything except filesystem-illegal chars and line breaks
// (spaces and unicode allowed; excludes tab, newline, / \ : * ? " < > |).
const PATH_SEGMENT = '[^\\t\\n\\\\/:*?"<>|]+';
const BARE_PATH_RE = new RegExp(
  "(?<![\\w])(" +
    "file:\\/\\/[^\\s<>\"']+" +
    `|[A-Za-z]:[\\\\/](?:${PATH_SEGMENT}[\\\\/])*${PATH_SEGMENT}\\.[A-Za-z0-9]+(?::\\d+)?` +
    // UNC: \\\\server\\share\\file.txt — regex \\\\ matches two literal backslashes,
    // so the template literal needs eight.
    `|\\\\\\\\(?:${PATH_SEGMENT}[\\\\/])+${PATH_SEGMENT}\\.[A-Za-z0-9]+(?::\\d+)?` +
    `|\\/(?:${PATH_SEGMENT}\\/)*[\\w.~-]+\\.[A-Za-z0-9]+(?::\\d+)?` +
    "|https?:\\/\\/[^\\s<>\"']+" +
    "|ftp:\\/\\/[^\\s<>\"']+" +
    ")",
  "gu",
);

function encodeFileUrl(pathPart: string): string {
  return pathPart
    .replace(/%/g, "%25")
    .replace(/\(/g, "%28")
    .replace(/\)/g, "%29")
    .replace(/ /g, "%20")
    .replace(/#/g, "%23")
    .replace(/\?/g, "%3F");
}

function linkifyPath(match: string): string {
  // Trim trailing sentence punctuation so ","/"."/";" don't join the link.
  const cleaned = match.replace(/[.,;:!?)\]}]+$/, "");
  if (!cleaned) return match;

  let target: string;
  if (/^(https?|ftp):\/\//i.test(cleaned)) {
    // Web URL: only markdown-breaking parens need escaping (spaces can't occur here).
    target = cleaned.replace(/\(/g, "%28").replace(/\)/g, "%29");
  } else if (/^file:\/\//i.test(cleaned)) {
    // Already a file URL: encode what breaks markdown/URL parsing, keep the rest.
    // Bare % that isn't a valid escape must be encoded first, or a later
    // decodeURIComponent (window.ts urlToWindowsPath) turns the link dead.
    target = cleaned
      .replace(/%(?![0-9A-Fa-f]{2})/g, "%25")
      .replace(/\(/g, "%28")
      .replace(/\)/g, "%29")
      .replace(/ /g, "%20")
      .replace(/#/g, "%23")
      .replace(/\?/g, "%3F");
  } else if (/^\\\\/.test(cleaned)) {
    // UNC path -> file://server/share (matches fileToMarkdownLink in ChatInput).
    target = "file:" + encodeFileUrl(cleaned.replace(/\\/g, "/"));
  } else if (/^[a-zA-Z]:[\\/]/.test(cleaned)) {
    // Windows drive path -> canonical file:/// URL (a bare "C:\..." href would be
    // read as protocol "c:" and stripped by the sanitizer).
    target = "file:///" + encodeFileUrl(cleaned.replace(/\\/g, "/"));
  } else {
    // Posix absolute path: protocol-less href passes the sanitizer as-is.
    target = cleaned.replace(/\(/g, "%28").replace(/\)/g, "%29").replace(/ /g, "%20");
  }
  // Function replacement: URL chars like $& would otherwise be treated as
  // special replacement patterns and corrupt the link.
  return match.replace(cleaned, () => `[${cleaned}](${target})`);
}

export function autolinkPathsInMarkdown(markdown: string): string {
  const lineBreak = markdown.includes("\r\n") ? "\r\n" : "\n";
  const lines = markdown.split(/\r?\n/);
  let fence: { marker: string; size: number } | null = null;

  return lines
    .map((line) => {
      const fenceMatch = line.match(/^ {0,3}(`{3,}|~{3,})/);
      if (fenceMatch) {
        const marker = fenceMatch[1][0];
        const size = fenceMatch[1].length;
        if (!fence) fence = { marker, size };
        else if (marker === fence.marker && size >= fence.size) fence = null;
        return line;
      }
      if (fence) return line;

      // Skip lines that already look like markdown links / images to avoid double-wrapping
      // (common in agent output: "see [build](dist/)" etc).
      if (line.includes("](") || line.trimStart().startsWith("![")) return line;

      // Protect inline code spans (single backticks) from being linkified.
      const spans = line.split(/(`+)/);
      let inCode = false;
      return spans
        .map((span) => {
          if (span.startsWith("`")) {
            inCode = !inCode;
            return span;
          }
          return inCode ? span : span.replace(BARE_PATH_RE, linkifyPath);
        })
        .join("");
    })
    .join(lineBreak);
}

export const markdownRemarkPlugins: ReactMarkdownOptions["remarkPlugins"] = [remarkGfm, remarkMath];

export const markdownRehypePlugins: ReactMarkdownOptions["rehypePlugins"] = [
  rehypeRaw,
  [rehypeSanitize, markdownSanitizeSchema],
  [rehypeKatex, { throwOnError: false, strict: false }],
];
