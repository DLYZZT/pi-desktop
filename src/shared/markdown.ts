import type { Options as ReactMarkdownOptions } from "react-markdown";
import type rehypeKatex from "rehype-katex";
import type rehypeRaw from "rehype-raw";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import { fileUrlToLocalPath, localFilePathToUrl } from "./file-url.ts";

export const markdownSanitizeSchema = {
  ...defaultSchema,
  attributes: {
    ...defaultSchema.attributes,
    code: [["className", /^language-./, "math-inline", "math-display"]],
  },
  protocols: {
    ...defaultSchema.protocols,
    href: [...(defaultSchema.protocols?.href ?? []), "file"],
  },
  strip: [...(defaultSchema.strip || []), "iframe", "object", "style", "form"],
};

type MarkdownNode = {
  type: string;
  value?: string;
  url?: string;
  lang?: string;
  children?: MarkdownNode[];
};

export type MarkdownFeatures = { math: boolean; html: boolean };

// Inspect the parsed tree so code examples, escaped dollars, and autolinks do
// not load optional renderers. This runs as part of the existing remark pass.
export function collectMarkdownFeatures(node: MarkdownNode, features: MarkdownFeatures): void {
  if (node.type === "math" || node.type === "inlineMath" || (node.type === "code" && node.lang === "math")) {
    features.math = true;
  }
  if (node.type === "html") {
    features.html = true;
    if (/\b(?:language-math|math-inline|math-display)\b/.test(node.value ?? "")) features.math = true;
  }
  for (const child of node.children ?? []) collectMarkdownFeatures(child, features);
}

const ABSOLUTE_PATH_PREFIX = String.raw`(?:file:\/\/|[A-Za-z]:[\\/]|\\\\|\/)`;
const PATH_LIST_SEPARATOR = String.raw`(?:\s+(?:and|or)\s+|\s*[和与及或]\s*)(?=${ABSOLUTE_PATH_PREFIX})`;
const PATH_SEGMENT_CHAR = String.raw`[^\t\n\\/:*?"<>|,;]`;
const PATH_SEGMENT = String.raw`(?:(?!${PATH_LIST_SEPARATOR})${PATH_SEGMENT_CHAR})+`;
const FILE_NAME_SEGMENT = String.raw`(?:(?!${PATH_LIST_SEPARATOR})${PATH_SEGMENT_CHAR})+?\.[A-Za-z0-9]+`;
const NO_SPACE_PATH_SEGMENT = String.raw`[^\s\t\n\\/:*?"<>|,;]+`;
const BARE_LOCAL_PATH_RE = new RegExp(
  "(?<![\\w:/])(" +
    "file:\\/\\/[^\\s<>\"']+" +
    `|[A-Za-z]:[\\\\/](?:${PATH_SEGMENT}[\\\\/])*${FILE_NAME_SEGMENT}(?::\\d+(?::\\d+)?)?(?![A-Za-z0-9./\\\\])` +
    `|\\\\\\\\(?:${PATH_SEGMENT}[\\\\/])+${FILE_NAME_SEGMENT}(?::\\d+(?::\\d+)?)?(?![A-Za-z0-9./\\\\])` +
    `|\\/(?:${PATH_SEGMENT}\\/)*${FILE_NAME_SEGMENT}(?::\\d+(?::\\d+)?)?(?![A-Za-z0-9./\\\\])` +
    `|\\/(?:${NO_SPACE_PATH_SEGMENT}\\/)+${NO_SPACE_PATH_SEGMENT}(?![\\/])` +
    ")",
  "gu",
);

const SKIPPED_MARKDOWN_NODE_TYPES = new Set(["link", "image", "code", "inlineCode", "html", "math", "inlineMath"]);

function splitLineSuffix(value: string): { path: string; suffix: string } {
  const match = /(:\d+(?::\d+)?)$/.exec(value);
  return match ? { path: value.slice(0, -match[1].length), suffix: match[1] } : { path: value, suffix: "" };
}

function trimSentencePunctuation(value: string): { value: string; trailing: string } {
  const cleaned = value.replace(/[.,;:!?)\]}]+$/, "");
  return { value: cleaned, trailing: value.slice(cleaned.length) };
}

function localPathLinkTarget(value: string): string | null {
  const { path, suffix } = splitLineSuffix(value);
  if (/^file:\/\//i.test(path)) {
    const decoded = fileUrlToLocalPath(path);
    const canonical = decoded ? localFilePathToUrl(decoded) : null;
    return canonical ? `${canonical}${suffix}` : null;
  }
  return localFilePathToUrl(path.replace(/\\/g, "/"))?.concat(suffix) ?? null;
}

export function linkifyLocalFileText(value: string): MarkdownNode[] {
  const nodes: MarkdownNode[] = [];
  let cursor = 0;
  for (const match of value.matchAll(BARE_LOCAL_PATH_RE)) {
    const index = match.index ?? 0;
    if (index > cursor) nodes.push({ type: "text", value: value.slice(cursor, index) });
    const raw = match[0];
    const { value: label, trailing } = trimSentencePunctuation(raw);
    const target = localPathLinkTarget(label);
    if (target) {
      nodes.push({ type: "link", url: target, children: [{ type: "text", value: label }] });
      if (trailing) nodes.push({ type: "text", value: trailing });
    } else {
      nodes.push({ type: "text", value: raw });
    }
    cursor = index + raw.length;
  }
  if (cursor < value.length) nodes.push({ type: "text", value: value.slice(cursor) });
  return nodes.length > 0 ? nodes : [{ type: "text", value }];
}

function transformLocalFileTextNodes(node: MarkdownNode, skipped = false): void {
  const skipChildren = skipped || SKIPPED_MARKDOWN_NODE_TYPES.has(node.type);
  if (skipChildren || !node.children) return;
  const nextChildren: MarkdownNode[] = [];
  for (const child of node.children) {
    if (child.type === "text" && typeof child.value === "string") {
      nextChildren.push(...linkifyLocalFileText(child.value));
    } else {
      transformLocalFileTextNodes(child, false);
      nextChildren.push(child);
    }
  }
  node.children = nextChildren;
}

export function remarkLocalFileLinks() {
  return (tree: MarkdownNode) => transformLocalFileTextNodes(tree);
}

export const markdownRemarkPlugins: ReactMarkdownOptions["remarkPlugins"] = [
  remarkGfm,
  remarkMath,
  remarkLocalFileLinks,
];

export type OptionalMarkdownPlugins = {
  raw?: typeof rehypeRaw;
  katex?: typeof rehypeKatex;
};

export function createMarkdownRehypePlugins({ raw, katex }: OptionalMarkdownPlugins = {}): NonNullable<
  ReactMarkdownOptions["rehypePlugins"]
> {
  const plugins: NonNullable<ReactMarkdownOptions["rehypePlugins"]> = [];
  if (raw) plugins.push(raw);
  plugins.push([rehypeSanitize, markdownSanitizeSchema]);
  if (katex) plugins.push([katex, { throwOnError: false, strict: false }]);
  return plugins;
}

export const markdownRehypePlugins = createMarkdownRehypePlugins();
