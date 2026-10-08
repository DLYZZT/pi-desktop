import type { AgentMessage, AssistantMessage, ImageContent } from "./types";
import { persistedImageSource } from "./persisted-image";

function imageIdentity(image: ImageContent): string | undefined {
  const ref = image.deferredContent;
  return ref ? `entry:${ref.entryId}:${ref.blockIndex ?? 0}` : persistedImageSource(image);
}

/** Project tool-generated images into the reply without changing transcript roles or stored data. */
export function withGeneratedImageReply(
  answer: AssistantMessage | null,
  finalAssistant: AssistantMessage,
  messages: readonly AgentMessage[],
  start: number,
  end: number,
): AssistantMessage | null {
  const images: ImageContent[] = [];
  const seen = new Set(
    (answer?.content ?? []).flatMap((block) => (block.type === "image" ? [imageIdentity(block)] : [])),
  );
  for (let index = start; index < end; index++) {
    const message = messages[index];
    if (message.role !== "toolResult" || message.toolName !== "codemode") continue;
    const details = message.details as { calls?: unknown } | undefined;
    if (
      !Array.isArray(details?.calls) ||
      !details.calls.some(
        (call) => call && typeof call === "object" && call.name === "models.generateImages" && call.status === "ok",
      )
    )
      continue;
    for (const block of message.content) {
      if (block.type !== "image") continue;
      const identity = imageIdentity(block);
      if (!identity || seen.has(identity)) continue;
      seen.add(identity);
      images.push(block);
    }
  }
  return images.length ? { ...(answer ?? finalAssistant), content: [...(answer?.content ?? []), ...images] } : answer;
}
