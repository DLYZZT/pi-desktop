export * from "@shared/types";

/** Which part of a stored entry a history page omitted: a content block or the message's `details`. */
export type DeferredContentPart = "content" | "details";

export type LoadDeferredContent = (entryId: string, blockIndex?: number, part?: DeferredContentPart) => Promise<void>;
