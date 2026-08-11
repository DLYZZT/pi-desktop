import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomUUID } from "node:crypto";
import { defaultHttpInstance, registerApp as registerOfficialApp } from "@larksuiteoapi/node-sdk";
import type { ChannelLoginEvent, FeishuDomain } from "../../../../shared/channel-types";
import { FEISHU_REQUIRED_TENANT_EVENTS, FEISHU_REQUIRED_TENANT_SCOPES } from "../../../../shared/feishu-app";
import { redactChannelText } from "../../redaction";
import type { AdapterLoginPollResult, AdapterLoginStartOptions, ChannelSecret } from "../../types";
import { FEISHU_BASE_URL, LARK_BASE_URL } from "./api";

const FEISHU_ACCOUNT_HOST = "accounts.feishu.cn";
const LARK_ACCOUNT_HOST = "accounts.larksuite.com";
const FEISHU_QR_HOST = "open.feishu.cn";
const LARK_QR_HOST = "open.larksuite.com";
const QR_READY_TIMEOUT_MS = 12_000;
const REGISTRATION_REQUEST_TIMEOUT_MS = 10_000;
const REGISTRATION_MAX_RESPONSE_BYTES = 64 * 1_024;
const REGISTRATION_MAX_REQUEST_BYTES = 16 * 1_024;
const REGISTRATION_ENDPOINT_PATH = "/oauth/v1/app/registration";
const SESSION_TTL_MS = 10 * 60_000;
const TERMINAL_RETENTION_MS = 60_000;
const DEFAULT_UI_POLL_MS = 1_000;
const ALLOWED_QR_HOSTS = new Set([FEISHU_ACCOUNT_HOST, LARK_ACCOUNT_HOST, FEISHU_QR_HOST, LARK_QR_HOST]);
const ALLOWED_REGISTRATION_HOSTS = new Set([FEISHU_ACCOUNT_HOST, LARK_ACCOUNT_HOST]);

type RegisterApp = typeof registerOfficialApp;

const registrationSignalContext = new AsyncLocalStorage<AbortSignal>();

// registerApp intentionally owns the protocol state machine. Its public options do
// not currently expose Axios request limits, though, and its AbortSignal otherwise
// only stops the polling timers. Harden only the documented registration endpoint
// on the SDK's exported HTTP instance so ordinary Feishu API traffic is untouched.
defaultHttpInstance.interceptors.request.use((request) => {
  let url: URL;
  try {
    url = new URL(request.url ?? "", request.baseURL);
  } catch {
    return request;
  }
  if (url.pathname !== REGISTRATION_ENDPOINT_PATH) return request;
  if (
    url.protocol !== "https:" ||
    !ALLOWED_REGISTRATION_HOSTS.has(url.hostname) ||
    url.username ||
    url.password ||
    url.port ||
    url.search ||
    url.hash
  ) {
    throw new Error("Blocked an untrusted Feishu/Lark app registration endpoint");
  }

  request.timeout = REGISTRATION_REQUEST_TIMEOUT_MS;
  request.maxContentLength = REGISTRATION_MAX_RESPONSE_BYTES;
  request.maxBodyLength = REGISTRATION_MAX_REQUEST_BYTES;
  request.maxRedirects = 0;
  const signal = registrationSignalContext.getStore();
  if (signal) request.signal = signal;
  return request;
});

function guardedOfficialRegisterApp(options: Parameters<RegisterApp>[0]): ReturnType<RegisterApp> {
  if (!options.signal) return registerOfficialApp(options);
  return registrationSignalContext.run(options.signal, () => registerOfficialApp(options));
}

type RegistrationSession = {
  key: string;
  requestedDomain: FeishuDomain;
  effectiveDomain: FeishuDomain;
  controller: AbortController;
  event: ChannelLoginEvent;
  startedAt: number;
  expiresAt: number;
  terminalAt?: number;
  expiryTimer?: ReturnType<typeof setTimeout>;
  credential?: ChannelSecret;
  account?: AdapterLoginPollResult["account"];
  ready: () => void;
};

function copyEvent(event: ChannelLoginEvent): ChannelLoginEvent {
  return { ...event };
}

function terminal(phase: ChannelLoginEvent["phase"]): boolean {
  return ["confirmed", "already_connected", "expired", "error", "cancelled"].includes(phase);
}

function accountHost(domain: FeishuDomain): string {
  return domain === "lark" ? LARK_ACCOUNT_HOST : FEISHU_ACCOUNT_HOST;
}

function openPlatformBaseUrl(domain: FeishuDomain): string {
  return domain === "lark" ? LARK_BASE_URL : FEISHU_BASE_URL;
}

function validateQrUrl(raw: string): string {
  if (!raw || raw.length > 8_192) throw new Error("飞书/Lark 返回了无效的扫码链接");
  const url = new URL(raw);
  if (url.protocol !== "https:" || !ALLOWED_QR_HOSTS.has(url.hostname) || url.username || url.password) {
    throw new Error("飞书/Lark 返回了不受信任的扫码链接");
  }
  return url.toString();
}

function normalizeExpireIn(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Math.min(SESSION_TTL_MS, Math.floor(value * 1_000));
}

function normalizeAppId(value: unknown): string {
  const appId = typeof value === "string" ? value.trim() : "";
  if (!/^cli_[A-Za-z0-9]+$/.test(appId)) throw new Error("飞书/Lark 未返回有效的 App ID");
  return appId;
}

function normalizeAppSecret(value: unknown): string {
  const secret = typeof value === "string" ? value.trim() : "";
  if (!secret || secret.length > 4_096) throw new Error("飞书/Lark 未返回有效的 App Secret");
  return secret;
}

function normalizeOwnerUserId(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  return normalized && normalized.length <= 256 ? normalized : undefined;
}

export function feishuScanAccountId(domain: FeishuDomain, appId: string): string {
  const digest = createHash("sha256").update(`${domain}\0${appId}`).digest("hex").slice(0, 24);
  return `feishu-${digest}`;
}

function registrationError(error: unknown): { phase: ChannelLoginEvent["phase"]; message: string } {
  const record = error && typeof error === "object" ? (error as Record<string, unknown>) : undefined;
  const code = typeof record?.code === "string" ? record.code : "";
  const rawDescription = typeof record?.description === "string" ? record.description : "";
  const description = rawDescription ? redactChannelText(rawDescription).slice(0, 180) : "";
  if (code === "access_denied") return { phase: "cancelled", message: "你已拒绝创建飞书/Lark 应用。" };
  if (code === "expired_token") return { phase: "expired", message: "二维码已过期，请重新生成。" };
  if (code === "abort") return { phase: "cancelled", message: "扫码创建已取消。" };
  if (code === "rate_limit" || code === "rate_limited" || code === "429") {
    return { phase: "error", message: "飞书/Lark 请求过于频繁，请稍后重试。" };
  }
  if (code === "admin_restricted" || code === "forbidden") {
    return { phase: "error", message: "当前企业策略不允许创建应用，请联系管理员或使用已有应用接入。" };
  }
  if (code === "ECONNABORTED" || code === "ETIMEDOUT") {
    return { phase: "error", message: "飞书/Lark 注册请求超时，请检查网络后重试。" };
  }
  if (code === "ERR_FR_TOO_MANY_REDIRECTS" || code === "ERR_BAD_RESPONSE") {
    return { phase: "error", message: "飞书/Lark 注册服务返回异常，请稍后重试。" };
  }
  return {
    phase: "error",
    message: description
      ? `飞书/Lark 扫码创建失败：${description}`
      : "飞书/Lark 扫码创建失败，请重试或使用已有应用接入。",
  };
}

export class FeishuAppRegistration {
  private readonly sessions = new Map<string, RegistrationSession>();

  constructor(
    private readonly registerApp: RegisterApp = guardedOfficialRegisterApp,
    private readonly now: () => number = Date.now,
  ) {}

  async start(options: AdapterLoginStartOptions): Promise<ChannelLoginEvent> {
    if (options.channel !== "feishu") throw new Error("飞书/Lark 扫码参数无效");
    this.prune();
    const active = [...this.sessions.values()].find(
      (session) => session.requestedDomain === options.domain && !terminal(session.event.phase),
    );
    if (active && !options.force) return copyEvent(active.event);
    if (active) this.cancel(active.key);

    const key = randomUUID();
    let markReady = () => {};
    const ready = new Promise<void>((resolve) => {
      markReady = resolve;
    });
    const startedAt = this.now();
    const session: RegistrationSession = {
      key,
      requestedDomain: options.domain,
      effectiveDomain: options.domain,
      controller: new AbortController(),
      event: {
        channel: "feishu",
        sessionKey: key,
        phase: "waiting",
        message: "正在向飞书/Lark 申请安全二维码…",
        pollAfterMs: DEFAULT_UI_POLL_MS,
      },
      startedAt,
      expiresAt: startedAt + SESSION_TTL_MS,
      ready: markReady,
    };
    this.sessions.set(key, session);
    this.scheduleExpiry(session);
    void this.run(session);

    let readyTimer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      ready,
      new Promise<void>((resolve) => {
        readyTimer = setTimeout(() => {
          if (!terminal(session.event.phase) && !session.event.qrContent) {
            session.controller.abort();
            this.finish(session, "error", "飞书/Lark 二维码获取超时，请检查网络后重试。");
          }
          resolve();
        }, QR_READY_TIMEOUT_MS);
      }),
    ]);
    if (readyTimer) clearTimeout(readyTimer);
    return copyEvent(session.event);
  }

  poll(sessionKey: string): AdapterLoginPollResult {
    this.prune();
    const session = this.sessions.get(sessionKey);
    if (!session) {
      return {
        event: {
          channel: "feishu",
          sessionKey,
          phase: "error",
          message: "扫码会话不存在，请重新开始。",
        },
      };
    }
    if (!terminal(session.event.phase) && this.now() >= session.expiresAt) {
      session.controller.abort();
      this.finish(session, "expired", "二维码已过期，请重新生成。");
    }
    return {
      event: copyEvent(session.event),
      ...(session.event.phase === "confirmed" && session.credential ? { credential: session.credential } : {}),
      ...(session.event.phase === "confirmed" && session.account ? { account: { ...session.account } } : {}),
      ...(session.event.phase === "confirmed" && session.credential
        ? { finalize: () => this.complete(sessionKey) }
        : {}),
    };
  }

  cancel(sessionKey: string): void {
    const session = this.sessions.get(sessionKey);
    if (!session) return;
    session.controller.abort();
    session.credential = undefined;
    session.account = undefined;
    this.finish(session, "cancelled", "扫码创建已取消。");
  }

  private complete(sessionKey: string): void {
    const session = this.sessions.get(sessionKey);
    if (!session) return;
    this.clearExpiry(session);
    session.credential = undefined;
    session.account = undefined;
    this.sessions.delete(sessionKey);
  }

  private async run(session: RegistrationSession): Promise<void> {
    try {
      const result = await this.registerApp({
        domain: accountHost(session.requestedDomain),
        larkDomain: LARK_ACCOUNT_HOST,
        source: "pi-desktop",
        signal: session.controller.signal,
        createOnly: true,
        appPreset: {
          name: "Pi Desktop - {user}",
          desc: "由 Pi Agent Desktop 创建的智能助手机器人",
        },
        addons: {
          preset: false,
          scopes: { tenant: [...FEISHU_REQUIRED_TENANT_SCOPES] },
          events: { items: { tenant: [...FEISHU_REQUIRED_TENANT_EVENTS] } },
        },
        onQRCodeReady: (info) => {
          if (terminal(session.event.phase)) return;
          try {
            const qrContent = validateQrUrl(info.url);
            session.expiresAt = Math.min(
              session.startedAt + SESSION_TTL_MS,
              this.now() + normalizeExpireIn(info.expireIn),
            );
            session.event = {
              channel: "feishu",
              sessionKey: session.key,
              phase: "qr",
              message: "请使用飞书或 Lark 扫码，确认创建新的 Pi Desktop 机器人。",
              qrContent,
              expiresAt: session.expiresAt,
              pollAfterMs: DEFAULT_UI_POLL_MS,
            };
            this.scheduleExpiry(session);
          } catch (error) {
            session.controller.abort();
            this.finish(session, "error", error instanceof Error ? error.message : "飞书/Lark 扫码链接无效");
          } finally {
            session.ready();
          }
        },
        onStatusChange: (info) => {
          if (terminal(session.event.phase)) return;
          if (info.status === "domain_switched") {
            session.effectiveDomain = "lark";
            session.event = {
              ...session.event,
              phase: "waiting",
              message: "已识别为 Lark 租户，正在完成应用创建…",
            };
            return;
          }
          const pollAfterMs =
            info.status === "slow_down" && Number.isFinite(info.interval)
              ? Math.max(DEFAULT_UI_POLL_MS, Math.floor((info.interval ?? 1) * 1_000))
              : DEFAULT_UI_POLL_MS;
          session.event = {
            ...session.event,
            phase: "waiting",
            message: info.status === "slow_down" ? "飞书/Lark 正在处理授权，请稍候…" : "等待扫码并确认创建应用…",
            pollAfterMs,
          };
        },
      });
      if (terminal(session.event.phase) || session.controller.signal.aborted) return;
      const appId = normalizeAppId(result.client_id);
      const appSecret = normalizeAppSecret(result.client_secret);
      const resultDomain = result.user_info?.tenant_brand;
      const domain: FeishuDomain =
        resultDomain === "lark" ? "lark" : resultDomain === "feishu" ? "feishu" : session.effectiveDomain;
      const ownerUserId = normalizeOwnerUserId(result.user_info?.open_id);
      const accountId = feishuScanAccountId(domain, appId);
      session.effectiveDomain = domain;
      session.credential = {
        token: appSecret,
        providerAccountId: appId,
        baseUrl: openPlatformBaseUrl(domain),
      };
      session.account = {
        appId,
        domain,
        ...(ownerUserId ? { ownerUserId } : {}),
      };
      session.event = {
        channel: "feishu",
        sessionKey: session.key,
        phase: "confirmed",
        message: ownerUserId
          ? "飞书/Lark 应用创建成功，正在安全保存并连接机器人…"
          : "飞书/Lark 应用创建成功，正在安全保存；首次私聊仍需配对。",
        accountId,
      };
      this.clearExpiry(session);
      session.terminalAt = this.now();
    } catch (error) {
      if (terminal(session.event.phase)) return;
      const mapped = registrationError(error);
      this.finish(session, mapped.phase, mapped.message);
    } finally {
      session.ready();
    }
  }

  private finish(session: RegistrationSession, phase: ChannelLoginEvent["phase"], message: string): void {
    this.clearExpiry(session);
    session.event = {
      channel: "feishu",
      sessionKey: session.key,
      phase,
      message,
    };
    session.terminalAt = this.now();
    session.ready();
  }

  private clearExpiry(session: RegistrationSession): void {
    if (!session.expiryTimer) return;
    clearTimeout(session.expiryTimer);
    session.expiryTimer = undefined;
  }

  private scheduleExpiry(session: RegistrationSession): void {
    this.clearExpiry(session);
    if (terminal(session.event.phase)) return;
    const delay = Math.max(0, session.expiresAt - this.now());
    session.expiryTimer = setTimeout(() => {
      session.expiryTimer = undefined;
      if (this.sessions.get(session.key) !== session || terminal(session.event.phase)) return;
      if (this.now() < session.expiresAt) {
        this.scheduleExpiry(session);
        return;
      }
      session.controller.abort();
      this.finish(session, "expired", "二维码已过期，请重新生成。");
    }, delay);
    session.expiryTimer.unref?.();
  }

  private prune(): void {
    const now = this.now();
    for (const [key, session] of this.sessions) {
      if (session.terminalAt && now - session.terminalAt > TERMINAL_RETENTION_MS) {
        this.clearExpiry(session);
        session.credential = undefined;
        session.account = undefined;
        this.sessions.delete(key);
      } else if (!terminal(session.event.phase) && now - session.startedAt > SESSION_TTL_MS) {
        session.controller.abort();
        this.finish(session, "expired", "二维码已过期，请重新生成。");
      }
    }
  }
}
