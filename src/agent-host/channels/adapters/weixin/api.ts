import { randomBytes } from "node:crypto";
import type {
  WeixinMessage,
  WeixinQrStartResponse,
  WeixinQrStatusResponse,
  WeixinUpdatesResponse,
} from "./protocol-types";

export const WEIXIN_DEFAULT_BASE_URL = "https://ilinkai.weixin.qq.com";
export const WEIXIN_CHANNEL_VERSION = "2.4.6";
const WEIXIN_APP_ID = "bot";
const WEIXIN_CLIENT_VERSION = (2 << 16) | (4 << 8) | 6;
const DEFAULT_TIMEOUT_MS = 15_000;

function commonHeaders(): Record<string, string> {
  return {
    "iLink-App-Id": WEIXIN_APP_ID,
    "iLink-App-ClientVersion": String(WEIXIN_CLIENT_VERSION),
  };
}

function authenticatedHeaders(token: string): Record<string, string> {
  const uin = randomBytes(4).readUInt32BE(0);
  return {
    ...commonHeaders(),
    "Content-Type": "application/json",
    AuthorizationType: "ilink_bot_token",
    Authorization: `Bearer ${token}`,
    "X-WECHAT-UIN": Buffer.from(String(uin), "utf8").toString("base64"),
  };
}

function unauthenticatedPostHeaders(): Record<string, string> {
  const uin = randomBytes(4).readUInt32BE(0);
  return {
    ...commonHeaders(),
    "Content-Type": "application/json",
    AuthorizationType: "ilink_bot_token",
    "X-WECHAT-UIN": Buffer.from(String(uin), "utf8").toString("base64"),
  };
}

function baseInfo(): Record<string, unknown> {
  return {
    channel_version: WEIXIN_CHANNEL_VERSION,
    bot_agent: `PiDesktop/${process.env.PI_DESKTOP_VERSION?.trim() || "0.1.0"}`,
  };
}

function combineAbortSignal(
  signal: AbortSignal | undefined,
  timeoutMs: number,
): {
  signal: AbortSignal;
  cleanup: () => void;
} {
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

async function requestText(params: {
  baseUrl: string;
  endpoint: string;
  method: "GET" | "POST";
  body?: unknown;
  token?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
}): Promise<string> {
  const url = new URL(params.endpoint, params.baseUrl.endsWith("/") ? params.baseUrl : `${params.baseUrl}/`);
  const { signal, cleanup } = combineAbortSignal(params.signal, params.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      method: params.method,
      headers: params.token
        ? authenticatedHeaders(params.token)
        : params.method === "POST"
          ? unauthenticatedPostHeaders()
          : commonHeaders(),
      ...(params.body !== undefined ? { body: JSON.stringify(params.body) } : {}),
      signal,
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`Weixin API ${response.status}: ${text.slice(0, 160)}`);
    return text;
  } finally {
    cleanup();
  }
}

async function requestJson<T>(params: Parameters<typeof requestText>[0]): Promise<T> {
  return JSON.parse(await requestText(params)) as T;
}

export async function startQrLogin(localTokens: string[] = []): Promise<WeixinQrStartResponse> {
  return requestJson<WeixinQrStartResponse>({
    baseUrl: WEIXIN_DEFAULT_BASE_URL,
    endpoint: "ilink/bot/get_bot_qrcode?bot_type=3",
    method: "POST",
    body: { local_token_list: localTokens.slice(-10) },
  });
}

export async function pollQrLogin(params: {
  baseUrl: string;
  qrcode: string;
  verifyCode?: string;
}): Promise<WeixinQrStatusResponse> {
  let endpoint = `ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(params.qrcode)}`;
  if (params.verifyCode) endpoint += `&verify_code=${encodeURIComponent(params.verifyCode)}`;
  try {
    return await requestJson<WeixinQrStatusResponse>({
      baseUrl: params.baseUrl,
      endpoint,
      method: "GET",
      timeoutMs: 35_000,
    });
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") return { status: "wait" };
    throw error;
  }
}

export async function getUpdates(params: {
  baseUrl: string;
  token: string;
  cursor: string;
  timeoutMs: number;
  signal: AbortSignal;
}): Promise<WeixinUpdatesResponse> {
  try {
    return await requestJson<WeixinUpdatesResponse>({
      baseUrl: params.baseUrl,
      endpoint: "ilink/bot/getupdates",
      method: "POST",
      token: params.token,
      body: { get_updates_buf: params.cursor, base_info: baseInfo() },
      timeoutMs: params.timeoutMs,
      signal: params.signal,
    });
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      return { ret: 0, msgs: [], get_updates_buf: params.cursor };
    }
    throw error;
  }
}

export async function sendText(params: {
  baseUrl: string;
  token: string;
  to: string;
  text: string;
  contextToken?: string;
  runId?: string;
  clientId: string;
}): Promise<void> {
  const response = await requestJson<{ ret?: number; errmsg?: string }>({
    baseUrl: params.baseUrl,
    endpoint: "ilink/bot/sendmessage",
    method: "POST",
    token: params.token,
    body: {
      msg: {
        from_user_id: "",
        to_user_id: params.to,
        client_id: params.clientId,
        message_type: 2,
        message_state: 2,
        item_list: [{ type: 1, text_item: { text: params.text } }],
        context_token: params.contextToken,
        run_id: params.runId,
      },
      base_info: baseInfo(),
    },
  });
  if (response.ret && response.ret !== 0) throw new Error(`Weixin send failed: ${response.errmsg ?? response.ret}`);
}

export async function getTypingTicket(params: {
  baseUrl: string;
  token: string;
  userId: string;
  contextToken?: string;
}): Promise<string | undefined> {
  const response = await requestJson<{ ret?: number; typing_ticket?: string }>({
    baseUrl: params.baseUrl,
    endpoint: "ilink/bot/getconfig",
    method: "POST",
    token: params.token,
    body: {
      ilink_user_id: params.userId,
      context_token: params.contextToken,
      base_info: baseInfo(),
    },
  });
  return response.ret === 0 || response.ret === undefined ? response.typing_ticket : undefined;
}

export async function sendTyping(params: {
  baseUrl: string;
  token: string;
  userId: string;
  ticket: string;
  typing: boolean;
}): Promise<void> {
  await requestText({
    baseUrl: params.baseUrl,
    endpoint: "ilink/bot/sendtyping",
    method: "POST",
    token: params.token,
    body: {
      ilink_user_id: params.userId,
      typing_ticket: params.ticket,
      status: params.typing ? 1 : 2,
      base_info: baseInfo(),
    },
  });
}

export async function notifyLifecycle(params: {
  baseUrl: string;
  token: string;
  event: "start" | "stop";
}): Promise<void> {
  await requestText({
    baseUrl: params.baseUrl,
    endpoint: params.event === "start" ? "ilink/bot/msg/notifystart" : "ilink/bot/msg/notifystop",
    method: "POST",
    token: params.token,
    body: { base_info: baseInfo() },
    timeoutMs: 10_000,
  });
}

export function bodyFromWeixinMessage(message: WeixinMessage): {
  text: string;
  attachments: Array<{ kind: "image" | "voice" | "file" | "video"; name?: string }>;
} {
  const attachments: Array<{ kind: "image" | "voice" | "file" | "video"; name?: string }> = [];
  let text = "";
  for (const item of message.item_list ?? []) {
    if (!text && item.type === 1 && item.text_item?.text) text = String(item.text_item.text);
    if (!text && item.type === 3 && item.voice_item?.text) text = String(item.voice_item.text);
    if (item.type === 2) attachments.push({ kind: "image" });
    if (item.type === 3 && !item.voice_item?.text) attachments.push({ kind: "voice" });
    if (item.type === 4)
      attachments.push({ kind: "file", ...(item.file_item?.file_name ? { name: item.file_item.file_name } : {}) });
    if (item.type === 5) attachments.push({ kind: "video" });
  }
  return { text, attachments };
}
