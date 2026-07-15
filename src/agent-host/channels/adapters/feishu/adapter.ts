import { randomUUID } from "node:crypto";
import type {
  ChannelAccountConfig,
  DeliveryReceipt,
  FeishuDomain,
  InboundAttachment,
  InboundEnvelope,
} from "../../../../shared/channel-types";
import { splitChannelText } from "../../outbound-renderer";
import type {
  AdapterSendContext,
  AdapterStartContext,
  AdapterTurnContext,
  AdapterTurnOutput,
  ChannelAdapter,
  ChannelSecret,
  ChannelTurnProgressEvent,
} from "../../types";
import { safeChannelError } from "../../redaction";
import {
  canFallbackFromFeishuCard,
  defaultFeishuDependencies,
  type FeishuAdapterDependencies,
  type FeishuCredentials,
  type FeishuResourceRequest,
  type FeishuRichCardSession,
  type FeishuWsConnection,
} from "./api";
import type { FeishuBotIdentity, FeishuMenuEvent, FeishuMessageEvent, FeishuMessageMention } from "./protocol-types";
import {
  buildFeishuInterruptedCard,
  buildFeishuStreamingCard,
  FeishuRichMessageBuilder,
  type FeishuCard,
} from "./rich-renderer";

const FEISHU_TEXT_LIMIT = 20_000;
const DEFAULT_CARD_UPDATE_INTERVAL_MS = 400;
const FEISHU_MENU_COMMANDS: Readonly<Record<string, string>> = {
  pi_help: "/help",
  pi_status: "/status",
  pi_new: "/new",
  pi_compact: "/compact",
  pi_reload: "/reload",
};

function credentials(account: ChannelAccountConfig, secret: ChannelSecret): FeishuCredentials {
  const appId = account.appId?.trim();
  if (!appId) throw new Error("飞书/Lark App ID 尚未配置");
  return {
    appId,
    appSecret: secret.token,
    domain: (account.domain === "lark" ? "lark" : "feishu") satisfies FeishuDomain,
  };
}

function parseContent(content: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(content) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function mentionOpenId(mention: FeishuMessageMention): string | undefined {
  return mention.id.open_id;
}

function isBotMention(mention: FeishuMessageMention, botOpenId: string): boolean {
  return mentionOpenId(mention) === botOpenId;
}

function normalizeMessageText(text: string): string {
  return text
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function stripBotMentionKeys(text: string, mentions: FeishuMessageMention[] | undefined, botOpenId: string): string {
  let result = text;
  for (const mention of mentions ?? []) {
    if (isBotMention(mention, botOpenId) && mention.key) result = result.split(mention.key).join("");
  }
  return normalizeMessageText(result);
}

function postNodeText(value: unknown, botOpenId: string): string {
  if (!value || typeof value !== "object" || Array.isArray(value)) return "";
  const node = value as Record<string, unknown>;
  if (node.tag === "text" || node.tag === "a") return typeof node.text === "string" ? node.text : "";
  if (node.tag === "at") {
    if (node.user_id === botOpenId) return "";
    const name = typeof node.user_name === "string" ? node.user_name : "";
    return name ? `@${name}` : "";
  }
  return "";
}

function extractPostText(content: Record<string, unknown>, botOpenId: string): string {
  const direct = Array.isArray(content.content) ? content : undefined;
  const localized = direct
    ? direct
    : Object.values(content).find((value): value is Record<string, unknown> =>
        Boolean(
          value &&
          typeof value === "object" &&
          !Array.isArray(value) &&
          Array.isArray((value as Record<string, unknown>).content),
        ),
      );
  if (!localized) return "";
  const title = typeof localized.title === "string" ? localized.title : "";
  const rows = (localized.content as unknown[])
    .filter(Array.isArray)
    .map((row) => (row as unknown[]).map((node) => postNodeText(node, botOpenId)).join(""));
  return normalizeMessageText([title, ...rows].filter(Boolean).join("\n"));
}

function contentAndAttachments(
  event: FeishuMessageEvent,
  botOpenId: string,
): { text: string; attachments: InboundAttachment[] } {
  const type = event.message.message_type;
  const content = parseContent(event.message.content);
  if (type === "text") {
    return { text: typeof content?.text === "string" ? content.text : "", attachments: [] };
  }
  if (type === "post") return { text: content ? extractPostText(content, botOpenId) : "", attachments: [] };
  if (type === "image") return { text: "", attachments: [{ kind: "image" }] };
  if (type === "file") {
    return {
      text: "",
      attachments: [
        {
          kind: "file",
          ...(typeof content?.file_name === "string" ? { name: content.file_name } : {}),
        },
      ],
    };
  }
  if (type === "audio") return { text: "", attachments: [{ kind: "voice" }] };
  if (type === "media" || type === "video") return { text: "", attachments: [{ kind: "video" }] };
  return { text: "", attachments: [] };
}

function pendingResourceKey(accountId: string, envelopeId: string): string {
  return `${accountId}:${envelopeId}`;
}

function downloadableResources(event: FeishuMessageEvent): FeishuResourceRequest[] {
  const content = parseContent(event.message.content);
  if (!content) return [];
  const fileKey = typeof content.file_key === "string" ? content.file_key.trim() : "";
  const imageKey = typeof content.image_key === "string" ? content.image_key.trim() : "";
  const fileName = typeof content.file_name === "string" ? content.file_name : undefined;
  switch (event.message.message_type) {
    case "image":
      return imageKey
        ? [{ messageId: event.message.message_id, fileKey: imageKey, resourceType: "image", kind: "image" }]
        : [];
    case "file":
      return fileKey
        ? [
            {
              messageId: event.message.message_id,
              fileKey,
              resourceType: "file",
              kind: "file",
              ...(fileName ? { name: fileName } : {}),
            },
          ]
        : [];
    case "audio":
      return fileKey
        ? [
            {
              messageId: event.message.message_id,
              fileKey,
              resourceType: "file",
              kind: "voice",
              name: fileName || "voice.opus",
              mime: "audio/ogg",
            },
          ]
        : [];
    case "media":
    case "video":
      return fileKey
        ? [
            {
              messageId: event.message.message_id,
              fileKey,
              resourceType: "file",
              kind: "video",
              name: fileName || "video.mp4",
              mime: "video/mp4",
            },
          ]
        : [];
    default:
      return [];
  }
}

function receipt(context: Pick<AdapterSendContext, "account" | "peerId">, messageId: string): DeliveryReceipt {
  return {
    id: randomUUID(),
    channel: "feishu",
    accountId: context.account.id,
    peerId: context.peerId,
    messageId,
    deliveredAt: new Date().toISOString(),
  };
}

class FeishuTurnOutput implements AdapterTurnOutput {
  private readonly builder = new FeishuRichMessageBuilder();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private tail: Promise<void> = Promise.resolve();
  private session: FeishuRichCardSession | undefined;
  private lastDraft = "";
  private lastError: unknown;
  private disabled = false;
  private finished = false;
  private reactionTail: Promise<void> = Promise.resolve();
  private reactionId: string | undefined;

  constructor(
    private readonly context: AdapterTurnContext,
    private readonly intervalMs: number,
    private readonly startCard: (context: AdapterTurnContext, card: FeishuCard) => Promise<FeishuRichCardSession>,
    private readonly sendFinalCard: (context: AdapterTurnContext, card: FeishuCard) => Promise<DeliveryReceipt>,
    private readonly sendPlain: (context: AdapterTurnContext, text: string) => Promise<DeliveryReceipt>,
    private readonly addReaction: (context: AdapterTurnContext, emojiType: string) => Promise<string>,
    private readonly removeReaction: (context: AdapterTurnContext, reactionId: string) => Promise<void>,
  ) {
    this.queueReaction("THINKING");
    this.schedule(0);
  }

  private queueReaction(emojiType: string): void {
    if (!this.context.replyToMessageId) return;
    this.reactionTail = this.reactionTail
      .then(async () => {
        if (this.reactionId) {
          const previous = this.reactionId;
          this.reactionId = undefined;
          await this.removeReaction(this.context, previous).catch(() => undefined);
        }
        this.reactionId = await this.addReaction(this.context, emojiType);
      })
      .catch(() => {
        this.reactionId = undefined;
      });
  }

  update(event: ChannelTurnProgressEvent): void {
    if (this.finished) return;
    this.builder.update(event);
    this.schedule(this.intervalMs);
  }

  private schedule(delayMs: number): void {
    if (this.finished || this.disabled || this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      try {
        this.flush();
      } catch (error) {
        this.lastError = error;
        this.disabled = true;
      }
    }, delayMs);
  }

  private flush(): void {
    const draft = this.builder.renderDraft();
    if (!draft || draft === this.lastDraft) return;
    this.lastDraft = draft;
    this.tail = this.tail
      .then(async () => {
        if (this.disabled) return;
        if (!this.session) this.session = await this.startCard(this.context, buildFeishuStreamingCard());
        if (!this.finished) await this.session.update(draft);
      })
      .catch((error) => {
        // Rich preview is optional. A partial Agent event or CardKit failure
        // must disable only this turn and never escape the timer chain.
        this.lastError = error;
        this.disabled = true;
      });
  }

  private async sendDurableFinal(text: string, card: FeishuCard): Promise<DeliveryReceipt> {
    try {
      return await this.sendFinalCard(this.context, card);
    } catch (error) {
      if (!canFallbackFromFeishuCard(error)) throw error;
      return this.sendPlain(this.context, text);
    }
  }

  async finish(text: string): Promise<DeliveryReceipt> {
    this.finished = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    await this.tail;

    try {
      const final = this.builder.renderFinal(text);
      let result: DeliveryReceipt;
      if (this.session) {
        if (final.answerTruncated) {
          await this.session.finish(final.card).catch(() => undefined);
          result = await this.sendPlain(this.context, text);
        } else {
          try {
            await this.session.finish(final.card);
            result = receipt(this.context, this.session.messageId);
          } catch {
            // The streaming card already exists. Prefer a second durable final
            // card over losing the answer when the original card cannot finalize.
            result = await this.sendDurableFinal(text, final.card);
          }
        }
      } else {
        if (this.lastError && !canFallbackFromFeishuCard(this.lastError)) throw this.lastError;
        result = final.answerTruncated
          ? await this.sendPlain(this.context, text)
          : await this.sendDurableFinal(text, final.card);
      }
      this.queueReaction("DONE");
      return result;
    } catch (error) {
      this.queueReaction("ERROR");
      throw error;
    }
  }

  async cancel(): Promise<void> {
    this.finished = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    await this.tail;
    await this.session?.finish(buildFeishuInterruptedCard()).catch(() => undefined);
    this.queueReaction("ERROR");
  }
}

export function normalizeFeishuEvent(
  event: FeishuMessageEvent,
  account: ChannelAccountConfig,
  bot: FeishuBotIdentity,
): InboundEnvelope | null {
  if (!event.message?.message_id || !event.message.chat_id || event.sender?.sender_type !== "user") return null;
  const senderId = event.sender.sender_id?.open_id;
  if (!senderId) return null;
  const peerKind = event.message.chat_type === "p2p" ? "dm" : "group";
  const mentions = event.message.mentions;
  const mentionsBot = Boolean(mentions?.some((mention) => isBotMention(mention, bot.openId)));
  const normalized = contentAndAttachments(event, bot.openId);
  const text = stripBotMentionKeys(normalized.text, mentions, bot.openId);
  const threadId = event.message.thread_id || event.message.root_id;
  const parentMessageId = event.message.parent_id || event.message.root_id;
  const timestamp = Number(event.message.create_time);
  return {
    id: event.message.message_id,
    channel: "feishu",
    accountId: account.id,
    peer: { kind: peerKind, id: peerKind === "dm" ? senderId : event.message.chat_id },
    ...(threadId ? { threadId } : {}),
    sender: { id: senderId },
    text,
    mentionsBot,
    ...(parentMessageId ? { replyTo: { messageId: parentMessageId } } : {}),
    attachments: normalized.attachments,
    timestamp: Number.isFinite(timestamp) && timestamp > 0 ? timestamp : Date.now(),
    providerContext: { replyToMessageId: event.message.message_id },
  };
}

export function normalizeFeishuMenuEvent(
  event: FeishuMenuEvent,
  account: ChannelAccountConfig,
): InboundEnvelope | null {
  const senderId = event.operator?.operator_id?.open_id;
  const eventKey = event.event_key?.trim();
  const text = eventKey ? FEISHU_MENU_COMMANDS[eventKey] : undefined;
  if (!senderId || !text) return null;
  const rawTimestamp = Number(event.create_time ?? event.timestamp);
  const timestamp =
    Number.isFinite(rawTimestamp) && rawTimestamp > 0
      ? rawTimestamp < 10_000_000_000
        ? rawTimestamp * 1_000
        : rawTimestamp
      : Date.now();
  const id = event.event_id?.trim() || `menu:${senderId}:${eventKey}:${timestamp}`;
  const senderName = event.operator?.operator_name?.trim();
  return {
    id,
    channel: "feishu",
    accountId: account.id,
    peer: { kind: "dm", id: senderId },
    sender: { id: senderId, ...(senderName ? { name: senderName } : {}) },
    text,
    mentionsBot: true,
    attachments: [],
    timestamp,
  };
}

export class FeishuAdapter implements ChannelAdapter {
  readonly id = "feishu" as const;
  private readonly pendingMedia = new Map<string, FeishuMessageEvent>();

  constructor(
    private readonly dependencies: FeishuAdapterDependencies = defaultFeishuDependencies,
    private readonly cardUpdateIntervalMs = DEFAULT_CARD_UPDATE_INTERVAL_MS,
  ) {}

  async start(context: AdapterStartContext): Promise<void> {
    const { account, secret, signal, state, onInbound, onStatus } = context;
    const credential = credentials(account, secret);
    let connection: FeishuWsConnection | undefined;
    let terminalError: Error | undefined;
    let finishRuntime: (() => void) | undefined;
    let retryCount = 0;
    const runtimeDone = new Promise<void>((resolve) => {
      finishRuntime = resolve;
    });
    const onAbort = () => finishRuntime?.();
    signal.addEventListener("abort", onAbort, { once: true });
    onStatus({ state: "starting", connected: false, lastStartAt: Date.now(), retryCount: 0, lastError: undefined });

    try {
      const bot = await this.dependencies.getBotIdentity(credential);
      if (account.providerAccountId && account.providerAccountId !== bot.openId) {
        throw new Error("App ID/App Secret 与已保存的飞书/Lark机器人身份不匹配");
      }
      if (signal.aborted) return;
      const inFlight = new Set<string>();

      const dispatchInbound = (eventId: string, envelope: InboundEnvelope, sourceEvent?: FeishuMessageEvent) => {
        if (state.isProcessed(account.id, eventId) || inFlight.has(eventId)) return;
        inFlight.add(eventId);
        if (sourceEvent && envelope.attachments.length > 0) {
          this.pendingMedia.set(pendingResourceKey(account.id, envelope.id), sourceEvent);
        }
        onStatus({ lastInboundAt: Date.now(), lastEventAt: Date.now() });
        void onInbound(envelope)
          .then(() => state.markProcessed(account.id, eventId))
          .catch((error) => {
            context.log(`飞书/Lark 入站消息处理失败：${safeChannelError(error)}`);
          })
          .finally(() => {
            this.pendingMedia.delete(pendingResourceKey(account.id, envelope.id));
            inFlight.delete(eventId);
          });
      };

      const onMessage = (event: FeishuMessageEvent) => {
        const eventId = event.message?.message_id || event.event_id;
        onStatus({ lastEventAt: Date.now() });
        if (!eventId || state.isProcessed(account.id, eventId) || inFlight.has(eventId)) return;
        const envelope = normalizeFeishuEvent(event, account, bot);
        if (!envelope) {
          state.markProcessed(account.id, eventId);
          return;
        }
        // The SDK callback must return within three seconds, while an Agent turn can take
        // much longer. Suppress concurrent redelivery in memory, then persist the provider
        // message ID only after Channel Core has accepted/handled the envelope successfully.
        dispatchInbound(eventId, envelope, event);
      };

      const onMenu = (event: FeishuMenuEvent) => {
        onStatus({ lastEventAt: Date.now() });
        const envelope = normalizeFeishuMenuEvent(event, account);
        const providerEventId = event.event_id?.trim() || envelope?.id;
        const eventId = providerEventId?.startsWith("menu:") ? providerEventId : `menu:${providerEventId || "unknown"}`;
        if (state.isProcessed(account.id, eventId) || inFlight.has(eventId)) return;
        if (account.commandsEnabled !== true || !envelope) {
          state.markProcessed(account.id, eventId);
          return;
        }
        dispatchInbound(eventId, envelope);
      };

      connection = await this.dependencies.connect(
        credential,
        { onMessage, onMenu },
        {
          onError: (error) => {
            terminalError = error;
            onStatus({ state: "error", connected: false, lastError: safeChannelError(error) });
            finishRuntime?.();
          },
          onReconnecting: () => {
            retryCount += 1;
            onStatus({ state: "reconnecting", connected: false, retryCount });
          },
          onReconnected: () => {
            retryCount = 0;
            onStatus({
              state: "running",
              connected: true,
              retryCount: 0,
              lastConnectedAt: Date.now(),
              lastError: undefined,
            });
          },
        },
        signal,
      );
      if (signal.aborted) return;
      onStatus({
        state: "running",
        connected: true,
        retryCount: 0,
        lastConnectedAt: Date.now(),
        lastError: undefined,
      });
      await runtimeDone;
      if (terminalError && !signal.aborted) throw terminalError;
    } finally {
      signal.removeEventListener("abort", onAbort);
      connection?.close();
      onStatus({ state: "stopped", connected: false });
    }
  }

  async downloadInbound(context: Parameters<NonNullable<ChannelAdapter["downloadInbound"]>>[0]) {
    const event = this.pendingMedia.get(pendingResourceKey(context.account.id, context.envelope.id));
    if (!event) throw new Error("飞书/Lark 附件上下文已过期，请重新发送");
    const resources = downloadableResources(event);
    if (resources.length === 0) throw new Error("飞书/Lark 消息没有可下载的媒体资源标识");
    return Promise.all(
      resources.map((request) =>
        this.dependencies.downloadResource(credentials(context.account, context.secret), request),
      ),
    );
  }

  async send(context: AdapterSendContext): Promise<DeliveryReceipt> {
    if (context.attachments?.length) {
      let result: DeliveryReceipt | undefined;
      if (context.text.trim()) result = await this.sendMessage(context);
      for (let index = 0; index < context.attachments.length; index += 1) {
        const attachment = context.attachments[index];
        const keepThreadRoute = Boolean(context.threadId && context.replyToMessageId);
        const replyToMessageId = keepThreadRoute || (!result && index === 0) ? context.replyToMessageId : undefined;
        const messageId = await this.dependencies.sendMedia(credentials(context.account, context.secret), {
          peerId: context.peerId,
          ...attachment,
          ...(replyToMessageId ? { replyToMessageId } : {}),
          ...(keepThreadRoute ? { replyInThread: true } : {}),
        });
        result = receipt(context, messageId);
      }
      if (result) return result;
    }
    return this.sendMessage(context);
  }

  private async sendMessage(context: AdapterSendContext): Promise<DeliveryReceipt> {
    if (context.runId && this.dependencies.sendCard) {
      const final = new FeishuRichMessageBuilder().renderFinal(context.text);
      if (!final.answerTruncated) {
        try {
          const messageId = await this.dependencies.sendCard(credentials(context.account, context.secret), {
            peerId: context.peerId,
            card: final.card,
            ...(context.replyToMessageId ? { replyToMessageId: context.replyToMessageId } : {}),
            ...(context.threadId ? { replyInThread: true } : {}),
          });
          return receipt(context, messageId);
        } catch (error) {
          if (!canFallbackFromFeishuCard(error)) throw error;
        }
      }
    }
    return this.sendPlain(context);
  }

  private async sendPlain(context: AdapterSendContext): Promise<DeliveryReceipt> {
    const chunks = splitChannelText(context.text, FEISHU_TEXT_LIMIT);
    if (chunks.length === 0) throw new Error("Cannot send an empty Feishu/Lark message");
    const credential = credentials(context.account, context.secret);
    let messageId = "";
    for (const chunk of chunks) {
      messageId = await this.dependencies.sendText(credential, {
        peerId: context.peerId,
        text: chunk,
        ...(context.replyToMessageId ? { replyToMessageId: context.replyToMessageId } : {}),
        ...(context.threadId ? { replyInThread: true } : {}),
      });
    }
    return receipt(context, messageId);
  }

  beginTurn(context: AdapterTurnContext): AdapterTurnOutput {
    return new FeishuTurnOutput(
      context,
      this.cardUpdateIntervalMs,
      (turn, card) =>
        this.dependencies.startRichCard(credentials(turn.account, turn.secret), {
          peerId: turn.peerId,
          card,
          ...(turn.replyToMessageId ? { replyToMessageId: turn.replyToMessageId } : {}),
          ...(turn.threadId ? { replyInThread: true } : {}),
        }),
      async (turn, card) => {
        const messageId = await this.dependencies.sendCard(credentials(turn.account, turn.secret), {
          peerId: turn.peerId,
          card,
          ...(turn.replyToMessageId ? { replyToMessageId: turn.replyToMessageId } : {}),
          ...(turn.threadId ? { replyInThread: true } : {}),
        });
        return receipt(turn, messageId);
      },
      (turn, text) => this.sendPlain({ ...turn, text }),
      (turn, emojiType) => {
        if (!turn.replyToMessageId) return Promise.reject(new Error("Missing Feishu source message ID"));
        return this.dependencies.addReaction(credentials(turn.account, turn.secret), turn.replyToMessageId, emojiType);
      },
      (turn, reactionId) => {
        if (!turn.replyToMessageId) return Promise.resolve();
        return this.dependencies.removeReaction(
          credentials(turn.account, turn.secret),
          turn.replyToMessageId,
          reactionId,
        );
      },
    );
  }

  async probe(account: ChannelAccountConfig, secret: ChannelSecret) {
    try {
      const bot = await this.dependencies.getBotIdentity(credentials(account, secret));
      const platform = account.domain === "lark" ? "Lark" : "飞书";
      return {
        ok: true,
        accountId: account.id,
        providerAccountId: bot.openId,
        displayName: bot.name,
        message: `${platform} ${bot.name} (${bot.openId}) 连接正常`,
      };
    } catch (error) {
      return { ok: false, accountId: account.id, message: safeChannelError(error) };
    }
  }
}
