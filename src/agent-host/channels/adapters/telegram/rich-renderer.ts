import type { AssistantMessage, ToolResultMessage } from "../../../../shared/types";
import { normalizeToolCalls } from "../../../../shared/normalize";
import { redactChannelText, redactChannelValue } from "../../redaction";
import type { ChannelTurnProgressEvent } from "../../types";

export const TELEGRAM_RICH_MESSAGE_LIMIT = 32_768;
export const TELEGRAM_RICH_SAFE_LIMIT = 32_000;
const DRAFT_ANSWER_LIMIT = 14_000;
const THINKING_LIMIT = 3_000;
const TOOL_INPUT_LIMIT = 700;
const TOOL_OUTPUT_LIMIT = 1_400;
const MAX_TOOL_DETAILS = 8;

type ToolProgress = {
  id: string;
  name: string;
  args?: unknown;
  output?: unknown;
  running: boolean;
  isError: boolean;
};

function codePointLength(value: string): number {
  return [...value].length;
}

export function truncateTelegramText(value: string, maxCodePoints: number): string {
  if (codePointLength(value) <= maxCodePoints) return value;
  return `${[...value].slice(0, Math.max(0, maxCodePoints - 2)).join("")}\n…`;
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

/** Preserve useful Markdown while preventing model output from injecting Rich HTML or media blocks. */
export function sanitizeTelegramRichMarkdown(value: string): string {
  const normalized = redactChannelText(value).replace(/\r\n/g, "\n");
  const withoutMedia = normalized.replace(/!\[([^\]\n]*)\]\(([^)\n]+)\)/g, (_match, alt: string, rawTarget: string) => {
    const label = alt.trim() ? `图片：${alt.trim()}` : "图片链接";
    const target = safeLinkTarget(rawTarget);
    return target ? `[${label}](${target})` : label;
  });
  const withSafeLinks = withoutMedia.replace(
    /(?<!!)\[([^\]\n]+)\]\(([^)\n]+)\)/g,
    (_match, label: string, rawTarget: string) => {
      const target = safeLinkTarget(rawTarget);
      return target ? `[${label}](${target})` : label;
    },
  );
  return withSafeLinks.replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function escapeRichHtml(value: string): string {
  return redactChannelText(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function safeToolName(value: unknown, fallback?: string): string {
  const name = typeof value === "string" ? value.trim() : "";
  return name || fallback || "tool";
}

function safeValue(value: unknown, maxCodePoints: number): string {
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
  return truncateTelegramText(rendered || "（无输出）", maxCodePoints);
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

export class TelegramRichMessageBuilder {
  private readonly completedAssistants: AssistantMessage[] = [];
  private currentAssistant: AssistantMessage | null = null;
  private readonly tools = new Map<string, ToolProgress>();

  update(event: ChannelTurnProgressEvent): void {
    if (event.type === "message") {
      if (event.message.role === "assistant") {
        const message = normalizeToolCalls(event.message) as AssistantMessage;
        for (const block of Array.isArray(message.content) ? message.content : []) {
          if (block.type !== "toolCall") continue;
          if (!block.toolCallId) continue;
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

  private streamedAnswer(): string {
    return [...this.completedAssistants, ...(this.currentAssistant ? [this.currentAssistant] : [])]
      .map(assistantText)
      .filter(Boolean)
      .join("\n\n");
  }

  private renderProcess(final: boolean): string {
    const blocks: string[] = [];
    const thinking = truncateTelegramText(this.thinking().trim(), THINKING_LIMIT);
    if (thinking) {
      blocks.push(
        `<details${final ? "" : " open"}><summary>思考过程</summary>\n\n${sanitizeTelegramRichMarkdown(thinking)}\n\n</details>`,
      );
    }

    for (const tool of [...this.tools.values()].slice(0, MAX_TOOL_DETAILS)) {
      const status = tool.running ? "运行中" : tool.isError ? "失败" : "完成";
      const body: string[] = [];
      if (tool.args !== undefined)
        body.push(`**输入**\n\n${codeBlock(safeValue(tool.args, TOOL_INPUT_LIMIT), "json")}`);
      if (tool.output !== undefined) body.push(`**输出**\n\n${codeBlock(safeValue(tool.output, TOOL_OUTPUT_LIMIT))}`);
      if (body.length === 0) body.push(tool.running ? "正在执行…" : "未返回文本输出。");
      blocks.push(
        `<details${!final && tool.running ? " open" : ""}><summary>工具 · ${escapeRichHtml(tool.name)} · ${status}</summary>\n\n${body.join("\n\n")}\n\n</details>`,
      );
    }
    if (this.tools.size > MAX_TOOL_DETAILS)
      blocks.push(`_另有 ${this.tools.size - MAX_TOOL_DETAILS} 个工具调用未展开。_`);
    return blocks.join("\n\n");
  }

  renderDraft(): string {
    const activeTool = [...this.tools.values()].find((tool) => tool.running);
    const status = activeTool ? `正在运行工具 ${escapeRichHtml(activeTool.name)}…` : "正在思考…";
    const process = this.renderProcess(false);
    const answer = closeOpenCodeFence(
      truncateTelegramText(sanitizeTelegramRichMarkdown(this.streamedAnswer().trim()), DRAFT_ANSWER_LIMIT),
    );
    return [`<tg-thinking>${status}</tg-thinking>`, process, answer].filter(Boolean).join("\n\n");
  }

  renderPlainDraft(): string {
    const activeTool = [...this.tools.values()].find((tool) => tool.running);
    const status = activeTool ? `正在运行工具 ${activeTool.name}…` : "正在思考…";
    const answer = truncateTelegramText(redactChannelText(this.streamedAnswer().trim()), 3_800);
    return truncateTelegramText([status, answer].filter(Boolean).join("\n\n"), 4_000);
  }

  renderFinal(finalText: string): string {
    const process = this.renderProcess(true);
    const answer = sanitizeTelegramRichMarkdown(typeof finalText === "string" ? finalText.trim() : "");
    return [process, process && answer ? "---" : "", answer].filter(Boolean).join("\n\n");
  }
}
