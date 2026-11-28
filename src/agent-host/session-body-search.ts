import { stat } from "node:fs/promises";
import { RpcError } from "../contract/types";
import type { SessionEntry } from "../shared/types";
import { CHANNEL_ATTACHMENT_PROMPT_PLACEHOLDER } from "../shared/channel-message";
import { skillInvocationCommandText } from "../shared/skill-invocation";
import { getSessionContentSnapshot } from "./session-content-cache";
import { buildEntryPath } from "./session-history";
import { getMessageTextContent, resolveSessionPath, withUserMessageSource } from "./session-reader";

function* visibleText(entries: SessionEntry[]) {
  for (const entry of buildEntryPath(entries).reverse()) {
    if (entry.type !== "message") continue;
    const message = entry.message;
    if (message.role !== "assistant" && message.role !== "user") continue;
    const value =
      message.role === "user"
        ? skillInvocationCommandText(getMessageTextContent(withUserMessageSource(message)))
        : getMessageTextContent(message);
    if (value && value !== CHANNEL_ATTACHMENT_PROMPT_PLACEHOLDER) yield value;
  }
}

function snippetFor(text: string, needle: string): string | undefined {
  const index = text.toLocaleLowerCase().indexOf(needle);
  if (index < 0) return;
  const from = Math.max(0, index - 32),
    to = Math.min(text.length, index + Math.min(needle.length, 100) + 48);
  return (from ? "…" : "") + text.slice(from, to).replace(/\s+/g, " ") + (to < text.length ? "…" : "");
}

// Cache only user-visible text and only after an explicit search. Bound both many small sessions and large histories.
const maxChars = 2_000_000;
const cache = new Map<string, { revision: string; texts: string[]; chars: number }>();
let cachedChars = 0;
async function searchOne(filename: string, query: string) {
  const file = await stat(filename);
  const revision = [file.dev, file.ino, file.size, file.mtimeMs, file.ctimeMs].join(":");
  const previous = cache.get(filename);
  if (previous?.revision === revision) {
    cache.delete(filename);
    cache.set(filename, previous);
    for (const text of previous.texts) {
      const snippet = snippetFor(text, query);
      if (snippet) return snippet;
    }
    return;
  }
  if (previous) {
    cache.delete(filename);
    cachedChars -= previous.chars;
  }
  const texts: string[] = [];
  let chars = 0,
    match: string | undefined;
  for (const text of visibleText(getSessionContentSnapshot(filename).entries)) {
    match ??= snippetFor(text, query);
    chars += text.length;
    if (chars <= maxChars) texts.push(text);
    else if (match) return match;
  }
  if (chars <= maxChars) {
    while (cachedChars + chars > maxChars || cache.size >= 128) {
      const [key, item] = cache.entries().next().value!;
      cache.delete(key);
      cachedChars -= item.chars;
    }
    cache.set(filename, { revision, texts, chars });
    cachedChars += chars;
  }
  return match;
}

export async function searchSessionMessages({ ids, query }: { ids: string[]; query: string }) {
  if (
    !Array.isArray(ids) ||
    ids.length > 8 ||
    ids.some((id) => typeof id !== "string" || !id || id.length > 256) ||
    typeof query !== "string" ||
    !query.trim() ||
    query.length > 256
  )
    throw new RpcError({ code: "BAD_REQUEST", message: "Invalid session search" });
  const needle = query.trim().toLocaleLowerCase();
  const matches: { id: string; snippet: string }[] = [];
  let unreadable = 0;
  for (const id of new Set(ids)) {
    const filename = await resolveSessionPath(id);
    if (!filename) continue;
    try {
      const snippet = await searchOne(filename, needle);
      if (snippet) matches.push({ id, snippet });
    } catch {
      unreadable++;
    }
  }
  return { matches, unreadable };
}
