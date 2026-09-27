import type { ToolResultMessage } from "./types";

type Translate = (key: string, fallback: string) => string;

// Recognize the persisted marker exactly. Ordinary output, including text that
// quotes the marker, must remain intact; the stored message is never modified.
const OMITTED_HERDR_RESULT = "[Sensitive Herdr result was not saved. Ask Pi to inspect the live Herdr fleet again.]";
const OMITTED_HERDR_ERROR = /^\[Herdr tool failed: (HERDR_[A-Z_]+)\. Live Herdr content was not saved\.\]$/;

export function getToolResultDisplayText(
  toolName: string,
  result: ToolResultMessage | undefined,
  t: Translate,
): string | null {
  if (!result) return null;
  const text = result.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n");
  if (
    !toolName.startsWith("herdr_") ||
    result.content.length !== 1 ||
    result.content[0].type !== "text" ||
    result.content[0].deferredContent
  ) {
    return text;
  }
  if (text === OMITTED_HERDR_RESULT) {
    return result.isError
      ? t("herdrFailedResultNotSaved", "The tool call failed. The original output was not saved in history.")
      : t("herdrResultNotSaved", "The original output was not saved in history.");
  }
  const error = result.isError ? OMITTED_HERDR_ERROR.exec(text) : null;
  return error
    ? t(
        "herdrFailedResultCodeNotSaved",
        "The tool call failed ({code}). The original output was not saved in history.",
      ).replace("{code}", error[1])
    : text;
}
