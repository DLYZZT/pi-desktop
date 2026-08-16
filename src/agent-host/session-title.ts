/**
 * Pure helpers for ChatGPT-style auto session titles (no I/O, no SDK imports).
 *
 * The Host combines these two paths: a silent LLM request produced by the
 * configured conversation model is sanitized via {@link sanitizeGeneratedTitle};
 * when that call fails or is unavailable, {@link makeFallbackTitle} guarantees
 * the session still receives a non-empty title so the sidebar never shows an
 * untitled conversation.
 */

export const AUTO_TITLE_MAX_LENGTH = 40;

export function takeCodePoints(value: string, max: number): string {
  return [...value].slice(0, max).join("");
}

/**
 * Normalize a model-generated title: collapse whitespace/newlines, strip
 * wrapping quotes/brackets, remove trailing punctuation, cap at
 * {@link AUTO_TITLE_MAX_LENGTH} characters. Returns null when nothing usable
 * remains.
 */
export function sanitizeGeneratedTitle(raw: string): string | null {
  const collapsed = raw
    .replace(/[\r\n]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const stripped = collapsed.replace(/^['"“”‘’「」『』]+|['"“”‘’「」『』]+$/g, "");
  const trimmed = stripped.replace(/[.。!！?？:：;；,\s]+$/u, "").trim();
  if (!trimmed) return null;
  return takeCodePoints(trimmed, AUTO_TITLE_MAX_LENGTH);
}

/**
 * Local fallback: reuse the first characters of the first user message as the
 * session title. Never returns an empty string.
 */
export function makeFallbackTitle(message: string): string {
  const normalized = message.replace(/\s+/g, " ").trim();
  if (!normalized) return "New session";
  return takeCodePoints(normalized, AUTO_TITLE_MAX_LENGTH);
}

/**
 * Extract plain text from an assistant message's content blocks (text,
 * thinking, tool calls) without depending on SDK text helpers.
 */
export function messageContentText(content: unknown): string {
  const pushText = (item: unknown) => {
    if (typeof item === "string") {
      return item;
    }
    if (item && typeof item === "object") {
      const text = (item as { text?: unknown }).text;
      if (typeof text === "string") return text;
    }
    return null;
  };
  if (Array.isArray(content)) {
    return content
      .map(pushText)
      .filter((part): part is string => part !== null)
      .join(" ");
  }
  return pushText(content) ?? "";
}
