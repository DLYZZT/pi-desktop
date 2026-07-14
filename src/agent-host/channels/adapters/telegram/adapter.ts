import { randomUUID } from "node:crypto";
import type {
  ChannelAccountConfig,
  DeliveryReceipt,
  InboundAttachment,
  InboundEnvelope,
} from "../../../../shared/channel-types";
import type {
  AdapterSendContext,
  AdapterStartContext,
  AdapterTurnContext,
  AdapterTurnOutput,
  AdapterTypingContext,
  ChannelAdapter,
  ChannelTurnProgressEvent,
} from "../../types";
import { CHANNEL_COMMAND_MENU } from "../../channel-commands";
import { splitChannelText } from "../../outbound-renderer";
import { safeChannelError } from "../../redaction";
import {
  escapeTelegramHtml,
  deleteTelegramCommands,
  getTelegramBot,
  getTelegramUpdates,
  sendTelegramChatAction,
  sendTelegramMessage,
  sendTelegramMessageDraft,
  sendTelegramRichMessage,
  sendTelegramRichMessageDraft,
  setTelegramCommands,
  TelegramApiError,
} from "./api";
import type { TelegramMessageEntity, TelegramUpdate, TelegramUser } from "./protocol-types";
import { TELEGRAM_RICH_SAFE_LIMIT, TelegramRichMessageBuilder } from "./rich-renderer";

const POLL_TIMEOUT_SECONDS = 30;
const MAX_RETRY_DELAY_MS = 30_000;
const DEFAULT_DRAFT_INTERVAL_MS = 400;

function telegramDraftId(value: string): number {
  let hash = 2_166_136_261;
  for (const character of value) {
    hash ^= character.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 16_777_619);
  }
  return hash >>> 1 || 1;
}

class TelegramTurnOutput implements AdapterTurnOutput {
  private readonly builder = new TelegramRichMessageBuilder();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private tail: Promise<void> = Promise.resolve();
  private lastDraft = "";
  private mode: "rich" | "plain" | "disabled";
  private finished = false;

  constructor(
    private readonly context: AdapterTurnContext,
    private readonly intervalMs: number,
    private readonly sendRichDraft: (context: AdapterTurnContext, draftId: number, markdown: string) => Promise<void>,
    private readonly sendPlainDraft: (context: AdapterTurnContext, draftId: number, text: string) => Promise<void>,
    private readonly sendFinal: (
      context: AdapterTurnContext,
      markdown: string,
      fallbackText: string,
    ) => Promise<DeliveryReceipt>,
  ) {
    const chatId = Number(context.peerId);
    this.mode = context.peerKind === "dm" && Number.isSafeInteger(chatId) ? "rich" : "disabled";
    this.schedule(0);
  }

  update(event: ChannelTurnProgressEvent): void {
    if (this.finished) return;
    this.builder.update(event);
    this.schedule(this.intervalMs);
  }

  private schedule(delayMs: number): void {
    if (this.finished || this.mode === "disabled" || this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      try {
        this.flush();
      } catch {
        // Draft rendering is optional. Malformed or partial Agent events must
        // never escape a timer callback and terminate the Agent Host.
        this.mode = "disabled";
      }
    }, delayMs);
  }

  private flush(): void {
    const richDraft = this.builder.renderDraft();
    const plainDraft = this.builder.renderPlainDraft();
    const next = this.mode === "rich" ? richDraft : plainDraft;
    if (!next || next === this.lastDraft) return;
    this.lastDraft = next;
    const draftId = telegramDraftId(this.context.runId ?? `${this.context.account.id}:${this.context.peerId}`);
    this.tail = this.tail.then(async () => {
      if (this.finished || this.mode === "disabled") return;
      if (this.mode === "rich") {
        try {
          await this.sendRichDraft(this.context, draftId, richDraft);
          return;
        } catch {
          this.mode = "plain";
          this.lastDraft = plainDraft;
        }
      }
      if (this.finished) return;
      try {
        await this.sendPlainDraft(this.context, draftId, plainDraft);
      } catch {
        this.mode = "disabled";
      }
    });
  }

  async finish(text: string): Promise<DeliveryReceipt> {
    this.finished = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    await this.tail;
    let markdown = "";
    try {
      markdown = this.builder.renderFinal(text);
    } catch {
      // Preserve the final reply through the established plain-text fallback.
    }
    return this.sendFinal(this.context, markdown, text);
  }

  async cancel(): Promise<void> {
    this.finished = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    await this.tail;
  }
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const finish = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    signal.addEventListener("abort", finish, { once: true });
  });
}

function isFatalTelegramError(error: unknown): boolean {
  return error instanceof TelegramApiError && [401, 403, 409].includes(error.errorCode);
}

function telegramErrorMessage(error: unknown): string {
  if (error instanceof TelegramApiError && error.errorCode === 409) {
    return "Telegram polling 冲突：请关闭其他使用该 Bot Token 的 poller，并确认 Bot 未配置 webhook";
  }
  if (error instanceof TelegramApiError && (error.errorCode === 401 || error.errorCode === 403)) {
    return "Telegram Bot Token 无效或机器人访问已被撤销，请更新 Token";
  }
  if (error instanceof TelegramApiError && error.errorCode === 429) {
    return `Telegram 请求受限，将在 ${error.retryAfter ?? 1} 秒后重试`;
  }
  if (error instanceof TelegramApiError && error.errorCode >= 500) {
    return "Telegram 服务暂时不可用，稍后将自动重试";
  }
  if (error instanceof TypeError || (error instanceof Error && /fetch failed|network/i.test(error.message))) {
    return "Telegram 网络请求失败，稍后将自动重试";
  }
  return safeChannelError(error);
}

function canFallbackFromRichMessage(error: unknown): boolean {
  return error instanceof TelegramApiError && [400, 404].includes(error.errorCode);
}

function entityText(text: string, entity: TelegramMessageEntity): string {
  return text.slice(entity.offset, entity.offset + entity.length);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function mentionsTelegramBot(
  text: string,
  entities: TelegramMessageEntity[],
  botId: string,
  botUsername?: string,
): boolean {
  const username = botUsername?.replace(/^@/, "").toLowerCase();
  if (
    entities.some((entity) => {
      if (entity.type === "text_mention") return String(entity.user?.id ?? "") === botId;
      if (!username || (entity.type !== "mention" && entity.type !== "bot_command")) return false;
      return entityText(text, entity).toLowerCase().endsWith(`@${username}`);
    })
  ) {
    return true;
  }
  return username ? new RegExp(`@${escapeRegExp(username)}(?![a-z0-9_])`, "i").test(text) : false;
}

function removeTelegramBotMention(text: string, botUsername?: string): string {
  const username = botUsername?.replace(/^@/, "");
  if (!username) return text.trim();
  return text.replace(new RegExp(`@${escapeRegExp(username)}(?![a-z0-9_])`, "gi"), "").trim();
}

function attachmentMetadata(update: TelegramUpdate): InboundAttachment[] {
  const message = update.message;
  if (!message) return [];
  const attachments: InboundAttachment[] = [];
  if (message.photo?.length) attachments.push({ kind: "image", mime: "image/jpeg" });
  if (message.voice)
    attachments.push({ kind: "voice", ...(message.voice.mime_type ? { mime: message.voice.mime_type } : {}) });
  if (message.document) {
    attachments.push({
      kind: "file",
      ...(message.document.file_name ? { name: message.document.file_name } : {}),
      ...(message.document.mime_type ? { mime: message.document.mime_type } : {}),
    });
  }
  if (message.audio) {
    attachments.push({
      kind: "file",
      ...(message.audio.file_name ? { name: message.audio.file_name } : {}),
      ...(message.audio.mime_type ? { mime: message.audio.mime_type } : {}),
    });
  }
  if (message.video || message.animation || message.video_note) {
    const media = message.video ?? message.animation ?? message.video_note;
    attachments.push({ kind: "video", ...(media?.mime_type ? { mime: media.mime_type } : {}) });
  }
  return attachments;
}

export function normalizeTelegramUpdate(
  update: TelegramUpdate,
  account: ChannelAccountConfig,
  bot: Pick<TelegramUser, "id" | "username">,
): InboundEnvelope | null {
  const message = update.message;
  const sender = message?.from;
  if (!message || !sender || sender.is_bot || message.chat.type === "channel") return null;
  const peerKind = message.chat.type === "private" ? "dm" : "group";
  const originalText = message.text ?? message.caption ?? "";
  const entities = message.text ? (message.entities ?? []) : (message.caption_entities ?? []);
  const mentionsBot = mentionsTelegramBot(originalText, entities, String(bot.id), bot.username);
  const senderName = [sender.first_name, sender.last_name].filter(Boolean).join(" ").trim();
  const repliedMessage = message.reply_to_message;
  const repliedText = repliedMessage?.text ?? repliedMessage?.caption;
  const repliedSenderId = repliedMessage?.from?.id ?? repliedMessage?.sender_chat?.id;
  return {
    id: String(update.update_id),
    channel: "telegram",
    accountId: account.id,
    peer: { kind: peerKind, id: String(message.chat.id) },
    ...(message.message_thread_id !== undefined ? { threadId: String(message.message_thread_id) } : {}),
    sender: {
      id: String(sender.id),
      ...(senderName ? { name: senderName } : {}),
      ...(sender.username ? { username: sender.username } : {}),
    },
    text: peerKind === "group" ? removeTelegramBotMention(originalText, bot.username) : originalText,
    mentionsBot,
    ...(repliedMessage
      ? {
          replyTo: {
            messageId: String(repliedMessage.message_id),
            ...(repliedText ? { text: repliedText } : {}),
            ...(repliedSenderId !== undefined ? { senderId: String(repliedSenderId) } : {}),
          },
        }
      : {}),
    attachments: attachmentMetadata(update),
    timestamp: message.date * 1_000,
    providerContext: { replyToMessageId: String(message.message_id) },
  };
}

export class TelegramAdapter implements ChannelAdapter {
  readonly id = "telegram" as const;

  constructor(
    private readonly sleep: (ms: number, signal: AbortSignal) => Promise<void> = delay,
    private readonly draftIntervalMs = DEFAULT_DRAFT_INTERVAL_MS,
  ) {}

  async start(context: AdapterStartContext): Promise<void> {
    const { account, secret, signal, state, onInbound, onStatus } = context;
    let offset = Number.parseInt(state.getCursor(account.id), 10);
    if (!Number.isSafeInteger(offset) || offset < 0) offset = 0;
    let failures = 0;
    onStatus({ state: "starting", connected: false, lastStartAt: Date.now(), retryCount: 0 });

    try {
      let bot: TelegramUser | undefined;
      while (!signal.aborted && !bot) {
        try {
          bot = await getTelegramBot({ baseUrl: secret.baseUrl, token: secret.token, signal });
        } catch (error) {
          if (signal.aborted) break;
          if (isFatalTelegramError(error)) throw new Error(telegramErrorMessage(error));
          failures += 1;
          const retryAfter = error instanceof TelegramApiError ? error.retryAfter : undefined;
          const backoff = retryAfter
            ? Math.min(Math.max(retryAfter, 1) * 1_000, MAX_RETRY_DELAY_MS)
            : Math.min(2_000 * 2 ** Math.min(failures - 1, 4), MAX_RETRY_DELAY_MS);
          onStatus({
            state: "reconnecting",
            connected: false,
            retryCount: failures,
            lastError: telegramErrorMessage(error),
          });
          await this.sleep(backoff, signal);
        }
      }
      if (!bot) return;
      if (account.providerAccountId && account.providerAccountId !== String(bot.id)) {
        throw new Error("Telegram Bot Token 与已保存的机器人账号不匹配");
      }
      try {
        if (account.commandsEnabled === true) {
          await setTelegramCommands({
            baseUrl: secret.baseUrl,
            token: secret.token,
            commands: CHANNEL_COMMAND_MENU.map((item) => ({ ...item })),
            signal,
          });
        } else if (account.commandsEnabled === false) {
          await deleteTelegramCommands({ baseUrl: secret.baseUrl, token: secret.token, signal });
        }
      } catch (error) {
        if (!signal.aborted) context.log(`Telegram 命令菜单同步失败：${telegramErrorMessage(error)}`);
      }
      failures = 0;
      onStatus({ state: "running", connected: true, lastConnectedAt: Date.now(), lastError: undefined });

      while (!signal.aborted) {
        try {
          const updates = await getTelegramUpdates({
            baseUrl: secret.baseUrl,
            token: secret.token,
            ...(offset > 0 ? { offset } : {}),
            timeoutSeconds: POLL_TIMEOUT_SECONDS,
            signal,
          });
          if (signal.aborted) break;

          for (const update of updates) {
            const eventId = String(update.update_id);
            if (!state.isProcessed(account.id, eventId)) {
              const envelope = normalizeTelegramUpdate(update, account, bot);
              if (envelope) {
                onStatus({ lastInboundAt: Date.now(), lastEventAt: Date.now() });
                await onInbound(envelope);
              }
              state.markProcessed(account.id, eventId);
            }
          }

          if (updates.length > 0) {
            const nextOffset = Math.max(...updates.map((update) => update.update_id)) + 1;
            if (nextOffset > offset) {
              offset = nextOffset;
              state.setCursor(account.id, String(offset));
            }
          }
          failures = 0;
          onStatus({ state: "running", connected: true, lastEventAt: Date.now(), retryCount: 0, lastError: undefined });
        } catch (error) {
          if (signal.aborted) break;
          if (isFatalTelegramError(error)) throw new Error(telegramErrorMessage(error));
          failures += 1;
          const retryAfter = error instanceof TelegramApiError ? error.retryAfter : undefined;
          const backoff = retryAfter
            ? Math.min(Math.max(retryAfter, 1) * 1_000, MAX_RETRY_DELAY_MS)
            : Math.min(2_000 * 2 ** Math.min(failures - 1, 4), MAX_RETRY_DELAY_MS);
          onStatus({
            state: "reconnecting",
            connected: false,
            retryCount: failures,
            lastError: telegramErrorMessage(error),
          });
          await this.sleep(backoff, signal);
        }
      }
    } finally {
      onStatus({ state: "stopped", connected: false });
    }
  }

  private async retryRateLimit<T>(operation: () => Promise<T>): Promise<T> {
    let attempts = 0;
    while (true) {
      try {
        return await operation();
      } catch (error) {
        if (!(error instanceof TelegramApiError) || error.errorCode !== 429 || attempts >= 2) throw error;
        attempts += 1;
        await this.sleep(
          Math.min(Math.max(error.retryAfter ?? 1, 1) * 1_000, MAX_RETRY_DELAY_MS),
          new AbortController().signal,
        );
      }
    }
  }

  private receipt(context: Pick<AdapterSendContext, "account" | "peerId">, messageId: string): DeliveryReceipt {
    return {
      id: randomUUID(),
      channel: "telegram",
      accountId: context.account.id,
      peerId: context.peerId,
      messageId,
      deliveredAt: new Date().toISOString(),
    };
  }

  private async sendPlain(context: AdapterSendContext): Promise<DeliveryReceipt> {
    const chunks = splitChannelText(context.text, 4_000);
    if (chunks.length === 0) throw new Error("Cannot send an empty Telegram message");
    let messageId = "";
    for (let index = 0; index < chunks.length; index += 1) {
      const message = await this.retryRateLimit(() =>
        sendTelegramMessage({
          baseUrl: context.secret.baseUrl,
          token: context.secret.token,
          chatId: context.peerId,
          html: escapeTelegramHtml(chunks[index]),
          threadId: context.threadId,
          ...(index === 0 && context.replyToMessageId ? { replyToMessageId: context.replyToMessageId } : {}),
        }),
      );
      messageId = String(message.message_id);
    }
    return this.receipt(context, messageId);
  }

  private async sendRichOrFallback(
    context: AdapterSendContext,
    markdown: string,
    fallbackText: string,
  ): Promise<DeliveryReceipt> {
    if (!markdown.trim() || [...markdown].length > TELEGRAM_RICH_SAFE_LIMIT) {
      return this.sendPlain({ ...context, text: fallbackText });
    }
    try {
      const message = await this.retryRateLimit(() =>
        sendTelegramRichMessage({
          baseUrl: context.secret.baseUrl,
          token: context.secret.token,
          chatId: context.peerId,
          markdown,
          threadId: context.threadId,
          replyToMessageId: context.replyToMessageId,
        }),
      );
      return this.receipt(context, String(message.message_id));
    } catch (error) {
      if (!canFallbackFromRichMessage(error)) throw error;
      return this.sendPlain({ ...context, text: fallbackText });
    }
  }

  async send(context: AdapterSendContext): Promise<DeliveryReceipt> {
    const builder = new TelegramRichMessageBuilder();
    return this.sendRichOrFallback(context, builder.renderFinal(context.text), context.text);
  }

  beginTurn(context: AdapterTurnContext): AdapterTurnOutput {
    return new TelegramTurnOutput(
      context,
      this.draftIntervalMs,
      async (turn, draftId, markdown) => {
        if ([...markdown].length > TELEGRAM_RICH_SAFE_LIMIT) {
          throw new Error("Telegram Rich Message draft exceeds the safe limit");
        }
        await sendTelegramRichMessageDraft({
          baseUrl: turn.secret.baseUrl,
          token: turn.secret.token,
          chatId: turn.peerId,
          draftId,
          markdown,
          threadId: turn.threadId,
        });
      },
      async (turn, draftId, text) => {
        await sendTelegramMessageDraft({
          baseUrl: turn.secret.baseUrl,
          token: turn.secret.token,
          chatId: turn.peerId,
          draftId,
          text,
          threadId: turn.threadId,
        });
      },
      (turn, markdown, fallbackText) =>
        this.sendRichOrFallback({ ...turn, text: fallbackText }, markdown, fallbackText),
    );
  }

  async setTyping(context: AdapterTypingContext): Promise<void> {
    if (!context.typing) return;
    await sendTelegramChatAction({
      baseUrl: context.secret.baseUrl,
      token: context.secret.token,
      chatId: context.peerId,
      threadId: context.threadId,
    });
  }

  async probe(account: ChannelAccountConfig, secret: AdapterStartContext["secret"]) {
    try {
      const bot = await getTelegramBot({ baseUrl: secret.baseUrl, token: secret.token });
      const providerUsername = bot.username ? `@${bot.username.replace(/^@/, "")}` : undefined;
      return {
        ok: true,
        accountId: account.id,
        providerAccountId: String(bot.id),
        ...(providerUsername ? { providerUsername } : {}),
        displayName: [bot.first_name, providerUsername].filter(Boolean).join(" "),
        message: `Telegram ${providerUsername ?? bot.first_name} (${bot.id}) 连接正常`,
      };
    } catch (error) {
      return { ok: false, accountId: account.id, message: telegramErrorMessage(error) };
    }
  }
}
