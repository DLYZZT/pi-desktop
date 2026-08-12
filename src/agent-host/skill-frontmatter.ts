import { isMap, parseDocument } from "yaml";

const MODEL_INVOCATION_KEY = "disable-model-invocation";

type FrontmatterBlock = {
  yaml: string;
  body: string;
  openingNewline: string;
  closingNewline: string;
};

function splitFrontmatter(content: string): FrontmatterBlock | undefined {
  const openingNewline = content.startsWith("---\r\n") ? "\r\n" : content.startsWith("---\n") ? "\n" : undefined;
  if (!openingNewline) return undefined;

  const yamlStart = 3 + openingNewline.length;
  let lineStart = yamlStart;
  while (lineStart <= content.length) {
    const lineFeed = content.indexOf("\n", lineStart);
    const lineEnd = lineFeed === -1 ? content.length : lineFeed;
    const rawLine = content.slice(lineStart, lineEnd);
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
    if (line === "---") {
      const closingNewline = lineFeed === -1 ? "" : rawLine.endsWith("\r") ? "\r\n" : "\n";
      return {
        yaml: content.slice(yamlStart, lineStart),
        body: lineFeed === -1 ? "" : content.slice(lineFeed + 1),
        openingNewline,
        closingNewline,
      };
    }
    if (lineFeed === -1) break;
    lineStart = lineFeed + 1;
  }
  return undefined;
}

export function updateSkillModelInvocation(content: string, disabled: boolean): string {
  const block = splitFrontmatter(content);
  if (!block) {
    if (!disabled) return content;
    const newline = content.includes("\r\n") ? "\r\n" : "\n";
    return `---${newline}${MODEL_INVOCATION_KEY}: true${newline}---${newline}${content}`;
  }

  const document = parseDocument(block.yaml);
  if (document.errors.length > 0) throw document.errors[0];
  if (!isMap(document.contents)) throw new Error("Skill frontmatter must be a YAML mapping");

  const hasKey = document.has(MODEL_INVOCATION_KEY);
  if ((disabled && document.get(MODEL_INVOCATION_KEY) === true) || (!disabled && !hasKey)) return content;
  if (disabled) document.set(MODEL_INVOCATION_KEY, true);
  else document.delete(MODEL_INVOCATION_KEY);

  const serialized = document.toString({ lineWidth: 0 }).replace(/\n$/, "").replace(/\n/g, block.openingNewline);
  return `---${block.openingNewline}${serialized}${block.openingNewline}---${block.closingNewline}${block.body}`;
}
