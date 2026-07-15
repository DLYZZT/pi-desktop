import { Buffer } from "node:buffer";
import type { AssistantMessage, ToolResultMessage } from "../../../../shared/types";
import { normalizeToolCalls } from "../../../../shared/normalize";
import { redactChannelText, redactChannelValue } from "../../redaction";
import type { ChannelTurnProgressEvent } from "../../types";

export const FEISHU_STREAM_ELEMENT_ID = "stream_md";
const FEISHU_CARD_JSON_LIMIT_BYTES = 28_000;
const STREAM_CONTENT_LIMIT_BYTES = 18_000;
const THINKING_LIMIT_BYTES = 4_000;
const TOOL_INPUT_LIMIT_BYTES = 900;
const TOOL_OUTPUT_LIMIT_BYTES = 1_800;
const PROCESS_LIMIT_BYTES = 7_000;
const MAX_TOOL_DETAILS = 8;

export type FeishuCard = Record<string, unknown>;

type ToolProgress = {
  id: string;
  name: string;
  args?: unknown;
  output?: unknown;
  running: boolean;
  isError: boolean;
};

export type FeishuFinalCardRender = {
  card: FeishuCard;
  answerTruncated: boolean;
};

function utf8Length(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

export function truncateFeishuText(value: string, maxBytes: number): string {
  if (utf8Length(value) <= maxBytes) return value;
  const suffix = "\n…";
  const suffixBytes = utf8Length(suffix);
  let used = 0;
  let result = "";
  for (const character of value) {
    const bytes = utf8Length(character);
    if (used + bytes + suffixBytes > maxBytes) break;
    result += character;
    used += bytes;
  }
  return `${result}${suffix}`;
}

function safeLinkTarget(raw: string): string | null {
  const target = raw.trim().replace(/\s+["'][\s\S]*["']$/, "");
  return /^(?:https?:|mailto:)/i.test(target) ? target : null;
}

function closeOpenCodeFence(markdown: string): string {
  let open: { char: string; length: number } | null = null;
  for (const match of markdown.matchAll(/^ {0,3}(`{3,}|~{3,}).*$/gm)) {
    const fence = match[1];
    if (!open) open = { char: fence[0], length: fence.length };
    else if (fence[0] === open.char && fence.length >= open.length) open = null;
  }
  return open ? `${markdown}\n${open.char.repeat(open.length)}` : markdown;
}

/** Keep standard Markdown while blocking raw Card JSON/HTML tags and unsafe link targets. */
export function sanitizeFeishuMarkdown(value: unknown): string {
  const normalized = redactChannelText(value).replace(/\r\n/g, "\n");
  const withoutMedia = normalized.replace(/!\[([^\]\n]*)\]\(([^)\n]+)\)/g, (_match, alt: string, raw: string) => {
    const label = alt.trim() ? `图片：${alt.trim()}` : "图片链接";
    const target = safeLinkTarget(raw);
    return target ? `[${label}](${target})` : label;
  });
  const withSafeLinks = withoutMedia.replace(
    /(?<!!)\[([^\]\n]+)\]\(([^)\n]+)\)/g,
    (_match, label: string, raw: string) => {
      const target = safeLinkTarget(raw);
      return target ? `[${label}](${target})` : label;
    },
  );
  return withSafeLinks.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function safeToolName(value: unknown, fallback?: string): string {
  const name = typeof value === "string" ? value.trim() : "";
  return sanitizeFeishuMarkdown(name || fallback || "tool");
}

function safeValue(value: unknown, maxBytes: number): string {
  let rendered: string;
  if (typeof value === "string") rendered = redactChannelText(value);
  else {
    try {
      rendered = JSON.stringify(redactChannelValue(value), null, 2) ?? String(value);
    } catch {
      try {
        rendered = String(value);
      } catch {
        rendered = "[无法序列化的工具输出]";
      }
    }
  }
  return truncateFeishuText(rendered || "（无输出）", maxBytes);
}

function codeBlock(value: string, language = ""): string {
  const longest = Math.max(0, ...[...value.matchAll(/`+/g)].map((match) => match[0].length));
  const fence = "`".repeat(Math.max(3, longest + 1));
  return `${fence}${language}\n${value}\n${fence}`;
}

function assistantText(message: AssistantMessage): string {
  if (!Array.isArray(message.content)) return "";
  return message.content
    .filter((block) => block.type === "text")
    .map((block) => (typeof block.text === "string" ? block.text : ""))
    .join("");
}

function assistantThinking(message: AssistantMessage): string {
  if (!Array.isArray(message.content)) return "";
  return message.content
    .filter((block) => block.type === "thinking")
    .map((block) => (typeof block.thinking === "string" ? block.thinking : ""))
    .join("\n");
}

function toolResultText(message: ToolResultMessage): string {
  if (!Array.isArray(message.content)) return "";
  return message.content
    .map((block) => (block.type === "text" ? (typeof block.text === "string" ? block.text : "") : "[媒体输出已省略]"))
    .join("\n");
}

function summaryText(value: string): string {
  const plain = redactChannelText(value)
    .replace(/```[\s\S]*?```/g, "代码")
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/[*_~`>#|]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return [...plain].slice(0, 80).join("") || "Pi Agent 回复";
}

export function buildFeishuStreamingCard(initialText = "正在思考…"): FeishuCard {
  return {
    schema: "2.0",
    header: { title: { tag: "plain_text", content: "Pi Agent" }, template: "blue" },
    config: {
      update_multi: true,
      streaming_mode: true,
      summary: { content: "[生成中…]" },
      streaming_config: {
        print_frequency_ms: { default: 70, android: 70, ios: 70, pc: 70 },
        print_step: { default: 1, android: 1, ios: 1, pc: 1 },
        print_strategy: "fast",
      },
    },
    body: {
      elements: [
        {
          tag: "markdown",
          element_id: FEISHU_STREAM_ELEMENT_ID,
          content: truncateFeishuText(initialText, STREAM_CONTENT_LIMIT_BYTES),
        },
      ],
    },
  };
}

function finalCard(process: string, answer: string, summary: string): FeishuCard {
  const elements: Array<Record<string, unknown>> = [];
  if (process) {
    elements.push({
      tag: "collapsible_panel",
      element_id: "process_panel",
      expanded: false,
      background_color: "grey",
      border: { color: "grey", corner_radius: "6px" },
      padding: "4px 8px 8px 8px",
      header: {
        title: { tag: "plain_text", content: "思考与工具调用" },
        icon: { tag: "standard_icon", token: "down-small-ccm_outlined" },
        icon_position: "right",
      },
      elements: [{ tag: "markdown", element_id: "process_md", content: process }],
    });
  }
  elements.push({ tag: "markdown", element_id: "answer_md", content: answer || "（无文本回复）" });
  return {
    schema: "2.0",
    header: { title: { tag: "plain_text", content: "Pi Agent" }, template: "blue" },
    config: { update_multi: true, streaming_mode: false, summary: { content: summary } },
    body: { elements },
  };
}

export function buildFeishuInterruptedCard(): FeishuCard {
  return finalCard("", "⚠️ 生成已中断，请重新发送消息。", "生成已中断");
}

export class FeishuRichMessageBuilder {
  private readonly completedAssistants: AssistantMessage[] = [];
  private currentAssistant: AssistantMessage | null = null;
  private readonly tools = new Map<string, ToolProgress>();

  update(event: ChannelTurnProgressEvent): void {
    if (event.type === "message") {
      if (event.message.role === "assistant") {
        const message = normalizeToolCalls(event.message) as AssistantMessage;
        for (const block of Array.isArray(message.content) ? message.content : []) {
          if (block.type !== "toolCall" || !block.toolCallId) continue;
          const existing = this.tools.get(block.toolCallId);
          this.tools.set(block.toolCallId, {
            id: block.toolCallId,
            name: safeToolName(block.toolName, existing?.name),
            args: block.input,
            running: existing?.running ?? false,
            isError: existing?.isError ?? false,
            ...(existing?.output !== undefined ? { output: existing.output } : {}),
          });
        }
        if (event.phase === "end") {
          this.completedAssistants.push(message);
          this.currentAssistant = null;
        } else {
          this.currentAssistant = message;
        }
      } else if (event.message.role === "toolResult") {
        const existing = this.tools.get(event.message.toolCallId);
        this.tools.set(event.message.toolCallId, {
          id: event.message.toolCallId,
          name: safeToolName(event.message.toolName, existing?.name),
          args: existing?.args,
          output: toolResultText(event.message),
          running: event.phase !== "end",
          isError: event.message.isError === true,
        });
      }
      return;
    }

    const existing = this.tools.get(event.toolCallId);
    if (event.type === "tool_start") {
      this.tools.set(event.toolCallId, {
        id: event.toolCallId,
        name: safeToolName(event.toolName, existing?.name),
        args: event.args,
        running: true,
        isError: false,
        ...(existing?.output !== undefined ? { output: existing.output } : {}),
      });
    } else if (event.type === "tool_update") {
      this.tools.set(event.toolCallId, {
        id: event.toolCallId,
        name: safeToolName(event.toolName, existing?.name),
        args: event.args,
        output: event.partialResult,
        running: true,
        isError: false,
      });
    } else {
      this.tools.set(event.toolCallId, {
        id: event.toolCallId,
        name: safeToolName(event.toolName, existing?.name),
        args: existing?.args,
        output: event.result,
        running: false,
        isError: event.isError,
      });
    }
  }

  private thinking(): string {
    return [...this.completedAssistants, ...(this.currentAssistant ? [this.currentAssistant] : [])]
      .map(assistantThinking)
      .filter(Boolean)
      .join("\n\n");
  }

  private answer(): string {
    return [...this.completedAssistants, ...(this.currentAssistant ? [this.currentAssistant] : [])]
      .map(assistantText)
      .filter(Boolean)
      .join("\n\n");
  }

  private process(): string {
    const blocks: string[] = [];
    const thinking = truncateFeishuText(sanitizeFeishuMarkdown(this.thinking().trim()), THINKING_LIMIT_BYTES);
    if (thinking) blocks.push(`**思考过程**\n\n${thinking}`);

    for (const tool of [...this.tools.values()].slice(0, MAX_TOOL_DETAILS)) {
      const status = tool.running ? "运行中" : tool.isError ? "失败" : "完成";
      const body: string[] = [];
      if (tool.args !== undefined)
        body.push(`**输入**\n\n${codeBlock(safeValue(tool.args, TOOL_INPUT_LIMIT_BYTES), "json")}`);
      if (tool.output !== undefined)
        body.push(`**输出**\n\n${codeBlock(safeValue(tool.output, TOOL_OUTPUT_LIMIT_BYTES))}`);
      if (body.length === 0) body.push(tool.running ? "正在执行…" : "未返回文本输出。");
      blocks.push(`**工具 · ${tool.name} · ${status}**\n\n${body.join("\n\n")}`);
    }
    if (this.tools.size > MAX_TOOL_DETAILS)
      blocks.push(`_另有 ${this.tools.size - MAX_TOOL_DETAILS} 个工具调用未展开。_`);
    return truncateFeishuText(blocks.join("\n\n---\n\n"), PROCESS_LIMIT_BYTES);
  }

  renderDraft(): string {
    const activeTool = [...this.tools.values()].find((tool) => tool.running);
    const status = activeTool ? `⏳ 正在运行工具 **${activeTool.name}**…` : "💭 正在思考…";
    const process = this.process();
    const answer = sanitizeFeishuMarkdown(this.answer().trim());
    return closeOpenCodeFence(
      truncateFeishuText([status, process, answer].filter(Boolean).join("\n\n---\n\n"), STREAM_CONTENT_LIMIT_BYTES),
    );
  }

  renderFinal(finalText: string): FeishuFinalCardRender {
    const process = this.process();
    const answer = sanitizeFeishuMarkdown(typeof finalText === "string" ? finalText.trim() : "");
    const card = finalCard(process, answer, summaryText(finalText));
    if (Buffer.byteLength(JSON.stringify(card), "utf8") <= FEISHU_CARD_JSON_LIMIT_BYTES) {
      return { card, answerTruncated: false };
    }
    const notice = "完整答案较长，已在下一条普通消息中发送。";
    return { card: finalCard(process, notice, summaryText(finalText)), answerTruncated: true };
  }
}
