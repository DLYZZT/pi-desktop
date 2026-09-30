import { toLlmContent } from "@earendil-works/pi-mcp";

/** Model text stays bounded; scripts and the execution journal retain the original MCP result. */
export function mcpModelContent(result: Parameters<typeof toLlmContent>[0]): ReturnType<typeof toLlmContent> {
  const content = toLlmContent(result),
    text = content
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("\n"),
    bytes = Buffer.from(text, "utf8");
  if (bytes.length <= 20 * 1024) return content;
  let head = 9 * 1024,
    tail = bytes.length - 9 * 1024;
  while ((bytes[head] & 0xc0) === 0x80) head--;
  while ((bytes[tail] & 0xc0) === 0x80) tail++;
  return [
    {
      type: "text",
      text: `${bytes.subarray(0, head).toString("utf8")}\n[… MCP output shortened from ${bytes.length} bytes …]\n${bytes.subarray(tail).toString("utf8")}\nUse tool_history_get to read this session's original MCP result.`,
    },
    ...content.filter((block) => block.type !== "text"),
  ];
}
