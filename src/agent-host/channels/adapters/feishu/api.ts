import { randomUUID } from "node:crypto";
import * as Lark from "@larksuiteoapi/node-sdk";
import type { FeishuDomain } from "../../../../shared/channel-types";
import type { FeishuCard } from "./rich-renderer";
import type { FeishuBotIdentity, FeishuMenuEvent, FeishuMessageEvent } from "./protocol-types";

export const FEISHU_BASE_URL = "https://open.feishu.cn";
export const LARK_BASE_URL = "https://open.larksuite.com";

export interface FeishuCredentials {
  appId: string;
  appSecret: string;
  domain: FeishuDomain;
}

export interface FeishuSendRequest {
  peerId: string;
  text: string;
  replyToMessageId?: string;
  replyInThread?: boolean;
}

export interface FeishuCardRequest extends Omit<FeishuSendRequest, "text"> {
  card: FeishuCard;
}

export interface FeishuRichCardSession {
  readonly cardId: string;
  readonly messageId: string;
  update(content: string): Promise<void>;
  finish(card: FeishuCard): Promise<void>;
}

export interface FeishuWsHooks {
  onError(error: Error): void;
  onReconnecting(): void;
  onReconnected(): void;
}

export interface FeishuWsConnection {
  close(): void;
}

export interface FeishuWsHandlers {
  onMessage(event: FeishuMessageEvent): void;
  onMenu(event: FeishuMenuEvent): void;
}

export interface FeishuAdapterDependencies {
  getBotIdentity(credentials: FeishuCredentials): Promise<FeishuBotIdentity>;
  sendText(credentials: FeishuCredentials, request: FeishuSendRequest): Promise<string>;
  sendCard(credentials: FeishuCredentials, request: FeishuCardRequest): Promise<string>;
  startRichCard(credentials: FeishuCredentials, request: FeishuCardRequest): Promise<FeishuRichCardSession>;
  addReaction(credentials: FeishuCredentials, messageId: string, emojiType: string): Promise<string>;
  removeReaction(credentials: FeishuCredentials, messageId: string, reactionId: string): Promise<void>;
  connect(
    credentials: FeishuCredentials,
    handlers: FeishuWsHandlers,
    hooks: FeishuWsHooks,
    signal: AbortSignal,
  ): Promise<FeishuWsConnection>;
}

type FeishuApiResponse = {
  code?: number;
  msg?: string;
  bot?: { open_id?: string; app_name?: string };
  data?: { message_id?: string; card_id?: string; reaction_id?: string };
};

export class FeishuApiError extends Error {
  readonly providerCode: number | undefined;
  readonly deliveryUnknown: boolean;

  constructor(message: string, providerCode?: number, deliveryUnknown = false) {
    super(message);
    this.name = "FeishuApiError";
    this.providerCode = providerCode;
    this.deliveryUnknown = deliveryUnknown;
  }
}

const silentLogger: Lark.Logger = {
  error: () => undefined,
  warn: () => undefined,
  info: () => undefined,
  debug: () => undefined,
  trace: () => undefined,
};

function sdkDomain(domain: FeishuDomain): Lark.Domain {
  return domain === "lark" ? Lark.Domain.Lark : Lark.Domain.Feishu;
}

function assertAppId(appId: string): void {
  if (!/^cli_[0-9a-f]{16}$/i.test(appId.trim())) {
    throw new Error("App ID 格式无效，应为飞书/Lark 自建应用的 cli_ 开头标识");
  }
}

function createClient(credentials: FeishuCredentials, httpInstance?: Lark.HttpInstance): Lark.Client {
  assertAppId(credentials.appId);
  return new Lark.Client({
    appId: credentials.appId,
    appSecret: credentials.appSecret,
    appType: Lark.AppType.SelfBuild,
    domain: sdkDomain(credentials.domain),
    loggerLevel: Lark.LoggerLevel.error,
    logger: silentLogger,
    source: "pi-desktop",
    ...(httpInstance ? { httpInstance } : {}),
  });
}

function apiFailure(response: FeishuApiResponse, operation: string): FeishuApiError | null {
  const code = response.code ?? 0;
  if (code === 0) return null;
  const raw = response.msg?.trim() || "未知错误";
  const permission = /permission|scope|forbidden|access denied|权限|授权/i.test(raw) || code === 99991663;
  const availability = /not available|availability|可用范围|未发布/i.test(raw);
  const hint = permission
    ? "请在开发者后台开通消息读取/发送权限并发布新版本"
    : availability
      ? "请发布应用并确认机器人对当前用户或群聊可用"
      : "请检查应用配置、发布状态和机器人权限";
  return new FeishuApiError(`${operation}失败（${code}）：${raw}。${hint}`, code);
}

function normalizeThrownError(
  error: unknown,
  operation: string,
  sensitiveValue?: string,
  deliveryUnknown = false,
): FeishuApiError {
  const sanitize = (value: string) => (sensitiveValue ? value.split(sensitiveValue).join("[REDACTED]") : value);
  if (error instanceof FeishuApiError) {
    // A structured provider response proves the request was rejected. Only
    // unstructured transport failures inherit the caller's delivery ambiguity.
    return new FeishuApiError(sanitize(error.message), error.providerCode, error.deliveryUnknown);
  }
  if (error instanceof Error) {
    const candidate = error as Error & { code?: number; response?: { data?: FeishuApiResponse } };
    const fromResponse = candidate.response?.data ? apiFailure(candidate.response.data, operation) : null;
    if (fromResponse) return new FeishuApiError(sanitize(fromResponse.message), fromResponse.providerCode);
    const message = sanitize(candidate.message);
    if (/timeout|network|socket|ENOTFOUND|ECONN/i.test(message)) {
      return new FeishuApiError(
        `${operation}失败：无法连接飞书/Lark 开放平台，请检查网络后重试`,
        undefined,
        deliveryUnknown,
      );
    }
    return new FeishuApiError(`${operation}失败：${message}`, undefined, deliveryUnknown);
  }
  return new FeishuApiError(`${operation}失败：${sanitize(String(error))}`, undefined, deliveryUnknown);
}

export function canFallbackFromFeishuCard(error: unknown): boolean {
  return error instanceof FeishuApiError && !error.deliveryUnknown;
}

export async function getFeishuBotIdentity(
  credentials: FeishuCredentials,
  httpInstance?: Lark.HttpInstance,
): Promise<FeishuBotIdentity> {
  try {
    const response = await createClient(credentials, httpInstance).request<FeishuApiResponse>({
      url: "/open-apis/bot/v3/info",
      method: "GET",
    });
    const failure = apiFailure(response, "读取机器人身份");
    if (failure) throw failure;
    const openId = response.bot?.open_id?.trim();
    if (!openId) throw new Error("读取机器人身份失败：接口未返回 bot open_id，请确认已启用机器人能力");
    return { openId, name: response.bot?.app_name?.trim() || "飞书机器人" };
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("读取机器人身份失败")) {
      throw new Error(error.message.split(credentials.appSecret).join("[REDACTED]"));
    }
    throw normalizeThrownError(error, "读取机器人身份", credentials.appSecret);
  }
}

function receiveIdType(peerId: string): "open_id" | "union_id" | "chat_id" {
  if (peerId.startsWith("ou_")) return "open_id";
  if (peerId.startsWith("on_")) return "union_id";
  return "chat_id";
}

async function sendFeishuPayload(
  client: Lark.Client,
  request: Omit<FeishuSendRequest, "text">,
  msgType: "text" | "interactive",
  content: string,
): Promise<string> {
  const response: FeishuApiResponse = request.replyToMessageId
    ? await client.im.v1.message.reply({
        path: { message_id: request.replyToMessageId },
        data: {
          content,
          msg_type: msgType,
          ...(request.replyInThread ? { reply_in_thread: true } : {}),
        },
      })
    : await client.im.v1.message.create({
        params: { receive_id_type: receiveIdType(request.peerId) },
        data: { receive_id: request.peerId, content, msg_type: msgType },
      });
  const failure = apiFailure(response, "发送消息");
  if (failure) throw failure;
  const messageId = response.data?.message_id?.trim();
  if (!messageId) throw new FeishuApiError("发送消息失败：接口未返回 message_id");
  return messageId;
}

export async function sendFeishuText(
  credentials: FeishuCredentials,
  request: FeishuSendRequest,
  httpInstance?: Lark.HttpInstance,
): Promise<string> {
  try {
    const client = createClient(credentials, httpInstance);
    const content = JSON.stringify({ text: request.text });
    return await sendFeishuPayload(client, request, "text", content);
  } catch (error) {
    throw normalizeThrownError(error, "发送消息", credentials.appSecret, true);
  }
}

export async function sendFeishuCard(
  credentials: FeishuCredentials,
  request: FeishuCardRequest,
  httpInstance?: Lark.HttpInstance,
): Promise<string> {
  try {
    return await sendFeishuPayload(
      createClient(credentials, httpInstance),
      request,
      "interactive",
      JSON.stringify(request.card),
    );
  } catch (error) {
    throw normalizeThrownError(error, "发送飞书/Lark Markdown 卡片", credentials.appSecret, true);
  }
}

class SdkFeishuRichCardSession implements FeishuRichCardSession {
  private sequence = 0;
  private readonly client: Lark.Client;
  readonly cardId: string;
  readonly messageId: string;
  private readonly appSecret: string;

  constructor(client: Lark.Client, cardId: string, messageId: string, appSecret: string) {
    this.client = client;
    this.cardId = cardId;
    this.messageId = messageId;
    this.appSecret = appSecret;
  }

  async update(content: string): Promise<void> {
    try {
      const response: FeishuApiResponse = await this.client.cardkit.v1.cardElement.content({
        path: { card_id: this.cardId, element_id: "stream_md" },
        data: { content, sequence: ++this.sequence, uuid: randomUUID() },
      });
      const failure = apiFailure(response, "更新流式卡片");
      if (failure) throw failure;
    } catch (error) {
      throw normalizeThrownError(error, "更新流式卡片", this.appSecret);
    }
  }

  async finish(card: FeishuCard): Promise<void> {
    const content = JSON.stringify(card);
    try {
      const response: FeishuApiResponse = await this.client.cardkit.v1.card.update({
        path: { card_id: this.cardId },
        data: {
          card: { type: "card_json", data: content },
          sequence: ++this.sequence,
          uuid: randomUUID(),
        },
      });
      const failure = apiFailure(response, "完成流式卡片");
      if (failure) throw failure;
      return;
    } catch (cardError) {
      try {
        const response: FeishuApiResponse = await this.client.im.v1.message.patch({
          path: { message_id: this.messageId },
          data: { content },
        });
        const failure = apiFailure(response, "完成流式卡片");
        if (failure) throw failure;
        return;
      } catch (patchError) {
        const cardMessage = normalizeThrownError(cardError, "完成流式卡片", this.appSecret).message;
        const patchMessage = normalizeThrownError(patchError, "完成流式卡片", this.appSecret).message;
        throw new FeishuApiError(`${cardMessage}；消息卡片回退更新也失败：${patchMessage}`);
      }
    }
  }
}

export async function startFeishuRichCard(
  credentials: FeishuCredentials,
  request: FeishuCardRequest,
  httpInstance?: Lark.HttpInstance,
): Promise<FeishuRichCardSession> {
  const client = createClient(credentials, httpInstance);
  let cardId = "";
  try {
    const response: FeishuApiResponse = await client.cardkit.v1.card.create({
      data: { type: "card_json", data: JSON.stringify(request.card) },
    });
    const failure = apiFailure(response, "创建流式卡片");
    if (failure) throw failure;
    cardId = response.data?.card_id?.trim() ?? "";
    if (!cardId) throw new FeishuApiError("创建流式卡片失败：接口未返回 card_id");
  } catch (error) {
    throw normalizeThrownError(error, "创建流式卡片", credentials.appSecret);
  }

  try {
    const messageId = await sendFeishuPayload(
      client,
      request,
      "interactive",
      JSON.stringify({ type: "card", data: { card_id: cardId } }),
    );
    return new SdkFeishuRichCardSession(client, cardId, messageId, credentials.appSecret);
  } catch (error) {
    throw normalizeThrownError(error, "发送流式卡片", credentials.appSecret, true);
  }
}

export async function addFeishuReaction(
  credentials: FeishuCredentials,
  messageId: string,
  emojiType: string,
  httpInstance?: Lark.HttpInstance,
): Promise<string> {
  try {
    const response: FeishuApiResponse = await createClient(credentials, httpInstance).im.v1.messageReaction.create({
      path: { message_id: messageId },
      data: { reaction_type: { emoji_type: emojiType } },
    });
    const failure = apiFailure(response, "添加消息状态");
    if (failure) throw failure;
    const reactionId = response.data?.reaction_id?.trim();
    if (!reactionId) throw new FeishuApiError("添加消息状态失败：接口未返回 reaction_id");
    return reactionId;
  } catch (error) {
    throw normalizeThrownError(error, "添加消息状态", credentials.appSecret);
  }
}

export async function removeFeishuReaction(
  credentials: FeishuCredentials,
  messageId: string,
  reactionId: string,
  httpInstance?: Lark.HttpInstance,
): Promise<void> {
  try {
    const response: FeishuApiResponse = await createClient(credentials, httpInstance).im.v1.messageReaction.delete({
      path: { message_id: messageId, reaction_id: reactionId },
    });
    const failure = apiFailure(response, "移除消息状态");
    if (failure) throw failure;
  } catch (error) {
    throw normalizeThrownError(error, "移除消息状态", credentials.appSecret);
  }
}

export function connectFeishuWebSocket(
  credentials: FeishuCredentials,
  handlers: FeishuWsHandlers,
  hooks: FeishuWsHooks,
  signal: AbortSignal,
  initialStatusDelayMs = 17_000,
): Promise<FeishuWsConnection> {
  assertAppId(credentials.appId);
  return new Promise((resolve, reject) => {
    let settled = false;
    let closed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const cleanupTimer = () => {
      if (timer) clearTimeout(timer);
      timer = undefined;
    };
    const close = () => {
      if (closed) return;
      closed = true;
      cleanupTimer();
      signal.removeEventListener("abort", onAbort);
      client.close({ force: true });
    };
    const failInitial = (error: Error) => {
      if (settled) return;
      settled = true;
      cleanupTimer();
      close();
      reject(error);
    };
    const onAbort = () => {
      if (settled) close();
      else failInitial(new Error("飞书/Lark 长连接已停止"));
    };

    const client = new Lark.WSClient({
      appId: credentials.appId,
      appSecret: credentials.appSecret,
      domain: sdkDomain(credentials.domain),
      loggerLevel: Lark.LoggerLevel.error,
      logger: silentLogger,
      source: "pi-desktop",
      autoReconnect: true,
      handshakeTimeoutMs: 15_000,
      wsConfig: { pingTimeout: 10 },
      onReady: () => {
        if (settled || signal.aborted) return;
        settled = true;
        cleanupTimer();
        resolve({ close });
      },
      onError: (error) => {
        const normalized = normalizeThrownError(error, "飞书/Lark 长连接", credentials.appSecret);
        hooks.onError(normalized);
        failInitial(normalized);
      },
      onReconnecting: hooks.onReconnecting,
      onReconnected: hooks.onReconnected,
    });

    const dispatcher = new Lark.EventDispatcher({
      loggerLevel: Lark.LoggerLevel.error,
      logger: silentLogger,
    }).register({
      "im.message.receive_v1": (event) => {
        handlers.onMessage(event as FeishuMessageEvent);
      },
      "application.bot.menu_v6": (event) => {
        handlers.onMenu(event as FeishuMenuEvent);
      },
    });

    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) {
      onAbort();
      return;
    }
    // WSClient owns the retry loop. A slow/offline initial connection must stay
    // alive so it can recover when the network returns; this timer only makes
    // the pending state visible instead of aborting the SDK after one attempt.
    timer = setTimeout(() => {
      timer = undefined;
      if (!settled && !closed) hooks.onReconnecting();
    }, initialStatusDelayMs);
    void client.start({ eventDispatcher: dispatcher }).catch((error: unknown) => {
      const normalized = normalizeThrownError(error, "飞书/Lark 长连接", credentials.appSecret);
      hooks.onError(normalized);
      failInitial(normalized);
    });
  });
}

export const defaultFeishuDependencies: FeishuAdapterDependencies = {
  getBotIdentity: getFeishuBotIdentity,
  sendText: sendFeishuText,
  sendCard: sendFeishuCard,
  startRichCard: startFeishuRichCard,
  addReaction: addFeishuReaction,
  removeReaction: removeFeishuReaction,
  connect: connectFeishuWebSocket,
};
