import { randomUUID } from "node:crypto";
import type { ChannelLoginEvent, DeliveryReceipt, InboundEnvelope } from "../../../../shared/channel-types";
import type {
  AdapterLoginPollResult,
  AdapterSendContext,
  AdapterStartContext,
  AdapterTypingContext,
  ChannelAdapter,
} from "../../types";
import { splitChannelText } from "../../outbound-renderer";
import { safeChannelError } from "../../redaction";
import {
  WEIXIN_DEFAULT_BASE_URL,
  bodyFromWeixinMessage,
  getTypingTicket,
  getUpdates,
  notifyLifecycle,
  pollQrLogin,
  sendText,
  sendTyping,
  startQrLogin,
} from "./api";
import { WeixinMessageType } from "./protocol-types";

type ActiveLogin = {
  sessionKey: string;
  qrcode: string;
  qrContent: string;
  baseUrl: string;
  startedAt: number;
  verifyCode?: string;
};

const LOGIN_TTL_MS = 5 * 60_000;
const STALE_TOKEN_CODE = -14;

function delay(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}

function loginEvent(
  sessionKey: string,
  phase: ChannelLoginEvent["phase"],
  message: string,
  qrContent?: string,
): ChannelLoginEvent {
  return {
    channel: "weixin",
    sessionKey,
    phase,
    message,
    ...(qrContent ? { qrContent } : {}),
  };
}

export class WeixinAdapter implements ChannelAdapter {
  readonly id = "weixin" as const;
  private readonly logins = new Map<string, ActiveLogin>();
  private readonly typingTickets = new Map<string, string>();

  constructor(private readonly sleep: (ms: number, signal: AbortSignal) => Promise<void> = delay) {}

  async start(context: AdapterStartContext): Promise<void> {
    const { account, secret, signal, state, onInbound, onStatus, log } = context;
    let cursor = state.getCursor(account.id);
    let timeoutMs = 35_000;
    let failures = 0;
    onStatus({ state: "starting", connected: false, lastStartAt: Date.now(), retryCount: 0 });
    await notifyLifecycle({ baseUrl: secret.baseUrl, token: secret.token, event: "start" }).catch((error) => {
      log(`weixin notify start failed: ${safeChannelError(error)}`);
    });
    onStatus({ state: "running", connected: true, lastConnectedAt: Date.now(), lastError: undefined });

    try {
      while (!signal.aborted) {
        try {
          const response = await getUpdates({
            baseUrl: secret.baseUrl,
            token: secret.token,
            cursor,
            timeoutMs,
            signal,
          });
          if (signal.aborted) break;
          if ((response.ret && response.ret !== 0) || (response.errcode && response.errcode !== 0)) {
            if (response.ret === STALE_TOKEN_CODE || response.errcode === STALE_TOKEN_CODE) {
              throw new Error("微信登录凭证已失效，请重新扫码登录");
            }
            throw new Error(`Weixin getUpdates failed: ${response.errmsg ?? response.errcode ?? response.ret}`);
          }
          failures = 0;
          timeoutMs = Math.max(5_000, Math.min(response.longpolling_timeout_ms ?? timeoutMs, 60_000));
          onStatus({ state: "running", connected: true, lastEventAt: Date.now(), retryCount: 0, lastError: undefined });

          for (const message of response.msgs ?? []) {
            if (message.message_type === WeixinMessageType.BOT) continue;
            const peerId = message.from_user_id?.trim();
            if (!peerId) continue;
            const eventId = String(message.message_id ?? message.seq ?? `${peerId}:${message.create_time_ms ?? 0}`);
            if (state.isProcessed(account.id, eventId)) continue;
            const normalized = bodyFromWeixinMessage(message);
            const envelope: InboundEnvelope = {
              id: eventId,
              channel: "weixin",
              accountId: account.id,
              peer: { kind: message.group_id ? "group" : "dm", id: message.group_id || peerId },
              sender: { id: peerId },
              text: normalized.text,
              mentionsBot: false,
              attachments: normalized.attachments,
              timestamp: message.create_time_ms ?? Date.now(),
              providerContext: {
                ...(message.context_token ? { contextToken: message.context_token } : {}),
              },
            };
            if (message.context_token) state.setContextToken(account.id, peerId, message.context_token);
            onStatus({ lastInboundAt: Date.now(), lastEventAt: Date.now() });
            await onInbound(envelope);
            state.markProcessed(account.id, eventId);
          }

          if (response.get_updates_buf && response.get_updates_buf !== cursor) {
            cursor = response.get_updates_buf;
            state.setCursor(account.id, cursor);
          }
        } catch (error) {
          if (signal.aborted) break;
          const message = safeChannelError(error);
          if (message.includes("凭证已失效")) throw error;
          failures += 1;
          onStatus({
            state: "reconnecting",
            connected: false,
            retryCount: failures,
            lastError: message,
          });
          await this.sleep(failures >= 3 ? 30_000 : 2_000, signal);
          if (failures >= 3) failures = 0;
        }
      }
    } finally {
      await notifyLifecycle({ baseUrl: secret.baseUrl, token: secret.token, event: "stop" }).catch(() => undefined);
      onStatus({ state: "stopped", connected: false });
    }
  }

  async send(context: AdapterSendContext): Promise<DeliveryReceipt> {
    const chunks = splitChannelText(context.text);
    if (chunks.length === 0) throw new Error("Cannot send an empty Weixin message");
    let clientId = "";
    for (const chunk of chunks) {
      clientId = randomUUID();
      await sendText({
        baseUrl: context.secret.baseUrl,
        token: context.secret.token,
        to: context.peerId,
        text: chunk,
        contextToken: context.contextToken,
        runId: context.runId,
        clientId,
      });
    }
    return {
      id: randomUUID(),
      channel: "weixin",
      accountId: context.account.id,
      peerId: context.peerId,
      messageId: clientId,
      deliveredAt: new Date().toISOString(),
    };
  }

  async setTyping(context: AdapterTypingContext): Promise<void> {
    const key = `${context.account.id}\u0000${context.peerId}`;
    let ticket = this.typingTickets.get(key);
    if (!ticket && context.typing) {
      ticket = await getTypingTicket({
        baseUrl: context.secret.baseUrl,
        token: context.secret.token,
        userId: context.peerId,
        contextToken: context.contextToken,
      });
      if (ticket) this.typingTickets.set(key, ticket);
    }
    if (!ticket) return;
    await sendTyping({
      baseUrl: context.secret.baseUrl,
      token: context.secret.token,
      userId: context.peerId,
      ticket,
      typing: context.typing,
    });
  }

  async probe(
    account: AdapterStartContext["account"],
    secret: AdapterStartContext["secret"],
  ): Promise<{ ok: boolean; message: string; accountId: string }> {
    try {
      await notifyLifecycle({ baseUrl: secret.baseUrl, token: secret.token, event: "start" });
      return { ok: true, message: "微信连接凭证有效", accountId: account.id };
    } catch (error) {
      return { ok: false, message: safeChannelError(error), accountId: account.id };
    }
  }

  async startLogin(force = false, localTokens: string[] = []): Promise<ChannelLoginEvent> {
    if (force) this.logins.clear();
    const response = await startQrLogin(localTokens);
    if (!response.qrcode || !response.qrcode_img_content) throw new Error("微信登录服务未返回二维码");
    const sessionKey = randomUUID();
    this.logins.set(sessionKey, {
      sessionKey,
      qrcode: response.qrcode,
      qrContent: response.qrcode_img_content,
      baseUrl: WEIXIN_DEFAULT_BASE_URL,
      startedAt: Date.now(),
    });
    return loginEvent(sessionKey, "qr", "请使用手机微信扫描二维码并确认连接。", response.qrcode_img_content);
  }

  async pollLogin(sessionKey: string): Promise<AdapterLoginPollResult> {
    const login = this.logins.get(sessionKey);
    if (!login) return { event: loginEvent(sessionKey, "error", "登录会话不存在，请重新开始。") };
    if (Date.now() - login.startedAt > LOGIN_TTL_MS) {
      this.logins.delete(sessionKey);
      return { event: loginEvent(sessionKey, "expired", "二维码已过期，请重新生成。") };
    }
    const response = await pollQrLogin({ baseUrl: login.baseUrl, qrcode: login.qrcode, verifyCode: login.verifyCode });
    if (this.logins.get(sessionKey) !== login) {
      return { event: loginEvent(sessionKey, "cancelled", "登录已取消。") };
    }
    if (response.status === "wait")
      return { event: loginEvent(sessionKey, "waiting", "等待扫码确认…", login.qrContent) };
    if (response.status === "scaned") {
      login.verifyCode = undefined;
      return { event: loginEvent(sessionKey, "scanned", "已扫码，请在手机上确认。", login.qrContent) };
    }
    if (response.status === "need_verifycode") {
      return { event: loginEvent(sessionKey, "verification_required", "请输入手机微信显示的数字。", login.qrContent) };
    }
    if (response.status === "scaned_but_redirect") {
      if (response.redirect_host) login.baseUrl = `https://${response.redirect_host}`;
      return { event: loginEvent(sessionKey, "scanned", "已扫码，正在连接微信服务…", login.qrContent) };
    }
    if (response.status === "binded_redirect") {
      this.logins.delete(sessionKey);
      return { event: loginEvent(sessionKey, "already_connected", "该微信账号已经连接。") };
    }
    if (response.status === "expired") {
      this.logins.delete(sessionKey);
      return { event: loginEvent(sessionKey, "expired", "二维码已过期，请重新生成。") };
    }
    if (response.status === "verify_code_blocked") {
      this.logins.delete(sessionKey);
      return { event: loginEvent(sessionKey, "error", "验证码错误次数过多，请稍后重新登录。") };
    }
    if (!response.bot_token || !response.ilink_bot_id) {
      return { event: loginEvent(sessionKey, "error", "微信确认成功，但登录凭证不完整。") };
    }
    this.logins.delete(sessionKey);
    const accountId = normalizeWeixinAccountId(response.ilink_bot_id);
    return {
      event: {
        ...loginEvent(sessionKey, "confirmed", "微信账号连接成功。"),
        accountId,
      },
      credential: {
        token: response.bot_token,
        providerAccountId: response.ilink_bot_id,
        baseUrl: response.baseurl?.trim() || login.baseUrl || WEIXIN_DEFAULT_BASE_URL,
        ...(response.ilink_user_id ? { userId: response.ilink_user_id } : {}),
      },
    };
  }

  submitLoginCode(sessionKey: string, code: string): void {
    const login = this.logins.get(sessionKey);
    if (!login) throw new Error("登录会话不存在");
    const normalized = code.trim();
    if (!/^\d{1,12}$/.test(normalized)) throw new Error("请输入手机微信显示的数字");
    login.verifyCode = normalized;
  }

  cancelLogin(sessionKey: string): void {
    this.logins.delete(sessionKey);
  }
}

export function normalizeWeixinAccountId(value: string): string {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return normalized || `weixin-${randomUUID()}`;
}
