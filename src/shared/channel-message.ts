import type { ChannelMessageAttachment, ImageContent } from "./types";

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

const ATTACHMENT_LABELS: Record<ChannelMessageAttachment["kind"], string> = {
  image: "Image",
  voice: "Voice message",
  file: "File",
  video: "Video",
};

function imageMime(block: ImageContent): string | undefined {
  const flat = block as unknown as { mimeType?: unknown };
  const value = block.source?.media_type ?? flat.mimeType;
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export function channelAttachmentCopyText(
  attachments: readonly ChannelMessageAttachment[] | undefined,
  imageBlocks: readonly ImageContent[] = [],
): string {
  const descriptors: readonly ChannelMessageAttachment[] =
    attachments && attachments.length > 0
      ? attachments
      : imageBlocks.map((block) => {
          const mime = imageMime(block);
          return { kind: "image", ...(mime ? { mime } : {}) };
        });

  return descriptors
    .map((attachment) => {
      const name = attachment.name?.trim();
      const mime = attachment.mime?.trim();
      const label = name || ATTACHMENT_LABELS[attachment.kind];
      return `Attachment: ${label}${mime ? ` (${mime})` : ""}`;
    })
    .join("\n");
}
