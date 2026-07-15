import type {
  TelegramApiResponse,
  TelegramMessage,
  TelegramResponseParameters,
  TelegramUpdate,
  TelegramUser,
} from "./protocol-types";

export const TELEGRAM_DEFAULT_BASE_URL = "https://api.telegram.org";
const DEFAULT_TIMEOUT_MS = 15_000;

export class TelegramApiError extends Error {
  readonly errorCode: number;
  readonly retryAfter?: number;
  readonly migrateToChatId?: number;
  readonly method: string;

  constructor(method: string, errorCode: number, description: string, parameters?: TelegramResponseParameters) {
    super(`Telegram ${method} failed (${errorCode}): ${description}`);
    this.name = "TelegramApiError";
    this.method = method;
    this.errorCode = errorCode;
    this.retryAfter = parameters?.retry_after;
    this.migrateToChatId = parameters?.migrate_to_chat_id;
  }
}

function combineAbortSignal(
  signal: AbortSignal | undefined,
  timeoutMs: number,
): { signal: AbortSignal; cleanup: () => void } {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const onAbort = () => controller.abort();
  if (signal?.aborted) controller.abort();
  else signal?.addEventListener("abort", onAbort, { once: true });
  return {
    signal: controller.signal,
    cleanup: () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    },
  };
}

export async function telegramRequest<T>(params: {
  baseUrl?: string;
  token: string;
  method: string;
  body?: Record<string, unknown>;
  timeoutMs?: number;
  signal?: AbortSignal;
}): Promise<T> {
  const baseUrl = (params.baseUrl?.trim() || TELEGRAM_DEFAULT_BASE_URL).replace(/\/+$/, "");
  const { signal, cleanup } = combineAbortSignal(params.signal, params.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  try {
    const response = await fetch(`${baseUrl}/bot${params.token}/${params.method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(params.body ?? {}),
      signal,
    });
    let payload: TelegramApiResponse<T>;
    try {
      payload = (await response.json()) as TelegramApiResponse<T>;
    } catch {
      throw new TelegramApiError(params.method, response.status || 500, "invalid JSON response");
    }
    if (!response.ok || !payload.ok || payload.result === undefined) {
      throw new TelegramApiError(
        params.method,
        payload.error_code ?? response.status ?? 500,
        payload.description ?? response.statusText ?? "unknown Telegram API error",
        payload.parameters,
      );
    }
    return payload.result;
  } finally {
    cleanup();
  }
}

export function getTelegramBot(params: {
  baseUrl?: string;
  token: string;
  signal?: AbortSignal;
}): Promise<TelegramUser> {
  return telegramRequest<TelegramUser>({ ...params, method: "getMe" });
}

export function getTelegramUpdates(params: {
  baseUrl?: string;
  token: string;
  offset?: number;
  timeoutSeconds: number;
  signal: AbortSignal;
}): Promise<TelegramUpdate[]> {
  return telegramRequest<TelegramUpdate[]>({
    baseUrl: params.baseUrl,
    token: params.token,
    method: "getUpdates",
    body: {
      ...(params.offset !== undefined ? { offset: params.offset } : {}),
      limit: 100,
      timeout: params.timeoutSeconds,
      allowed_updates: ["message"],
    },
    timeoutMs: (params.timeoutSeconds + 5) * 1_000,
    signal: params.signal,
  });
}

export function setTelegramCommands(params: {
  baseUrl?: string;
  token: string;
  commands: Array<{ command: string; description: string }>;
  signal?: AbortSignal;
}): Promise<true> {
  return telegramRequest<true>({
    baseUrl: params.baseUrl,
    token: params.token,
    method: "setMyCommands",
    body: { commands: params.commands },
    signal: params.signal,
  });
}

export function deleteTelegramCommands(params: {
  baseUrl?: string;
  token: string;
  signal?: AbortSignal;
}): Promise<true> {
  return telegramRequest<true>({
    baseUrl: params.baseUrl,
    token: params.token,
    method: "deleteMyCommands",
    signal: params.signal,
  });
}

export function sendTelegramMessage(params: {
  baseUrl?: string;
  token: string;
  chatId: string;
  html: string;
  threadId?: string;
  replyToMessageId?: string;
}): Promise<TelegramMessage> {
  const threadId = params.threadId ? Number(params.threadId) : undefined;
  const replyMessageId = params.replyToMessageId ? Number(params.replyToMessageId) : undefined;
  return telegramRequest<TelegramMessage>({
    baseUrl: params.baseUrl,
    token: params.token,
    method: "sendMessage",
    body: {
      chat_id: params.chatId,
      text: params.html,
      parse_mode: "HTML",
      link_preview_options: { is_disabled: true },
      ...(Number.isSafeInteger(threadId) ? { message_thread_id: threadId } : {}),
      ...(Number.isSafeInteger(replyMessageId)
        ? { reply_parameters: { message_id: replyMessageId, allow_sending_without_reply: true } }
        : {}),
    },
  });
}

export function sendTelegramMessageDraft(params: {
  baseUrl?: string;
  token: string;
  chatId: string;
  draftId: number;
  text: string;
  threadId?: string;
}): Promise<true> {
  const chatId = Number(params.chatId);
  const threadId = params.threadId ? Number(params.threadId) : undefined;
  return telegramRequest<true>({
    baseUrl: params.baseUrl,
    token: params.token,
    method: "sendMessageDraft",
    body: {
      chat_id: chatId,
      draft_id: params.draftId,
      text: params.text,
      ...(Number.isSafeInteger(threadId) ? { message_thread_id: threadId } : {}),
    },
  });
}

export function sendTelegramRichMessage(params: {
  baseUrl?: string;
  token: string;
  chatId: string;
  markdown: string;
  threadId?: string;
  replyToMessageId?: string;
}): Promise<TelegramMessage> {
  const threadId = params.threadId ? Number(params.threadId) : undefined;
  const replyMessageId = params.replyToMessageId ? Number(params.replyToMessageId) : undefined;
  return telegramRequest<TelegramMessage>({
    baseUrl: params.baseUrl,
    token: params.token,
    method: "sendRichMessage",
    body: {
      chat_id: params.chatId,
      rich_message: { markdown: params.markdown, skip_entity_detection: true },
      ...(Number.isSafeInteger(threadId) ? { message_thread_id: threadId } : {}),
      ...(Number.isSafeInteger(replyMessageId)
        ? { reply_parameters: { message_id: replyMessageId, allow_sending_without_reply: true } }
        : {}),
    },
  });
}

export function sendTelegramRichMessageDraft(params: {
  baseUrl?: string;
  token: string;
  chatId: string;
  draftId: number;
  markdown: string;
  threadId?: string;
}): Promise<true> {
  const chatId = Number(params.chatId);
  const threadId = params.threadId ? Number(params.threadId) : undefined;
  return telegramRequest<true>({
    baseUrl: params.baseUrl,
    token: params.token,
    method: "sendRichMessageDraft",
    body: {
      chat_id: chatId,
      draft_id: params.draftId,
      rich_message: { markdown: params.markdown, skip_entity_detection: true },
      ...(Number.isSafeInteger(threadId) ? { message_thread_id: threadId } : {}),
    },
  });
}

export function sendTelegramChatAction(params: {
  baseUrl?: string;
  token: string;
  chatId: string;
  threadId?: string;
}): Promise<true> {
  const threadId = params.threadId ? Number(params.threadId) : undefined;
  return telegramRequest<true>({
    baseUrl: params.baseUrl,
    token: params.token,
    method: "sendChatAction",
    body: {
      chat_id: params.chatId,
      action: "typing",
      ...(Number.isSafeInteger(threadId) ? { message_thread_id: threadId } : {}),
    },
  });
}

export function setTelegramMessageReaction(params: {
  baseUrl?: string;
  token: string;
  chatId: string;
  messageId: string;
  emoji: string;
}): Promise<true> {
  const messageId = Number(params.messageId);
  if (!Number.isSafeInteger(messageId)) return Promise.reject(new Error("Invalid Telegram message ID for reaction"));
  return telegramRequest<true>({
    baseUrl: params.baseUrl,
    token: params.token,
    method: "setMessageReaction",
    body: {
      chat_id: params.chatId,
      message_id: messageId,
      reaction: [{ type: "emoji", emoji: params.emoji }],
    },
  });
}

export function escapeTelegramHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
