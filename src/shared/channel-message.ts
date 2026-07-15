/**
 * Pi currently always creates a text content block for prompt(), while several
 * providers reject an empty block. U+FFFC is the standard object replacement
 * character for an inline attachment and carries no transport metadata.
 */
export const CHANNEL_ATTACHMENT_PROMPT_PLACEHOLDER = "\uFFFC";

export function channelPromptText(text: string, hasAttachments: boolean): string {
  if (text.trim().length > 0 || !hasAttachments) return text;
  return CHANNEL_ATTACHMENT_PROMPT_PLACEHOLDER;
}
