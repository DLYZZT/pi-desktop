import { createHash, randomInt, randomUUID } from "node:crypto";
import { homedir } from "node:os";
import path from "node:path";
import type { RpcServer } from "../../contract/rpc";
import type {
  ChannelAccountConfig,
  ChannelAccountView,
  ChannelActivity,
  ChannelBinding,
  ChannelId,
  ChannelLoginEvent,
  ChannelLoginStartRequest,
  ChannelProbeResult,
  ChannelStatus,
  ChannelsSnapshot,
  InboundEnvelope,
} from "../../shared/channel-types";
import type { AgentSessionWrapper } from "../rpc-manager";
import { AdapterRegistry } from "./adapter-registry";
import { channelCommandHelpText, parseChannelCommand, type ParsedChannelCommand } from "./channel-commands";
import { ChannelConfigStore } from "./config-store";
import { LaneScheduler } from "./lane-scheduler";
import { CHANNEL_MEDIA_MAX_ATTACHMENTS, ChannelMediaStore } from "./media-store";
import { callMain } from "../parent-rpc";
import { PiSessionBridge } from "./pi-session-bridge";
import { evaluateInboundPolicy } from "./policy";
import { fingerprintSecret, safeChannelError } from "./redaction";
import { ChannelStateStore } from "./state-store";
import type { AdapterTurnOutput, ChannelSecret, OutboundAttachment, StagedInboundAttachment } from "./types";
import { resolveSessionPath } from "../session-reader";
import { sessionIndex } from "../session-index";

type RuntimeEntry = { controller: AbortController; task: Promise<void> };
type StartingEntry = { controller: AbortController; task: Promise<void> };
type SecretAccess = {
  get: (channel: ChannelId, accountId: string) => Promise<ChannelSecret | null>;
  set: (channel: ChannelId, accountId: string, secret: ChannelSecret) => Promise<void>;
  delete: (channel: ChannelId, accountId: string) => Promise<void>;
};

export type ChannelManagerOptions = {
  dataDirectory?: string;
  registry?: AdapterRegistry;
  secretAccess?: SecretAccess;
  bridge?: Pick<PiSessionBridge, "getSessionStatus" | "newSession" | "runCommand" | "runTurn" | "syncTools">;
};

const PAIRING_TTL_MS = 10 * 60_000;
const LOGIN_SUCCESS_RETENTION_MS = 60_000;

function channelDisplayName(channel: ChannelId): string {
  if (channel === "weixin") return "微信";
  if (channel === "telegram") return "Telegram";
  return "飞书 / Lark";
}

function sameToolNames(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((name, index) => name === right[index]);
}

function userDataPath(): string {
  return (
    process.env.PI_DESKTOP_USER_DATA?.trim() ||
    (process.env.PI_CODING_AGENT_DIR ? path.join(process.env.PI_CODING_AGENT_DIR, "desktop") : "") ||
    path.join(homedir(), ".pi", "desktop")
  );
}

function secretKey(channel: ChannelId, accountId: string): string {
  return `channel:${channel}:${accountId}`;
}

function isChannelSecret(value: unknown): value is ChannelSecret {
  if (!value || typeof value !== "object") return false;
  const record = value as Partial<ChannelSecret>;
  return Boolean(record.token?.trim() && record.providerAccountId?.trim() && record.baseUrl?.trim());
}

function routeKey(envelope: InboundEnvelope): string {
  return [envelope.channel, envelope.accountId, envelope.peer.kind, envelope.peer.id, envelope.threadId ?? ""].join(
    ":",
  );
}

function bindingId(envelope: InboundEnvelope): string {
  return createHash("sha256").update(routeKey(envelope)).digest("hex").slice(0, 32);
}

function workspaceSegment(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 20);
}

function outboundAttachment(filePath: string): OutboundAttachment {
  const extension = path.extname(filePath).toLowerCase();
  const mime =
    (
      {
        ".jpg": "image/jpeg",
        ".jpeg": "image/jpeg",
        ".png": "image/png",
        ".gif": "image/gif",
        ".webp": "image/webp",
        ".ogg": "audio/ogg",
        ".opus": "audio/ogg",
        ".mp3": "audio/mpeg",
        ".m4a": "audio/mp4",
        ".wav": "audio/wav",
        ".silk": "audio/silk",
        ".mp4": "video/mp4",
        ".pdf": "application/pdf",
        ".txt": "text/plain",
        ".md": "text/markdown",
        ".json": "application/json",
        ".zip": "application/zip",
      } as Record<string, string>
    )[extension] ?? undefined;
  const kind = mime?.startsWith("image/")
    ? "image"
    : mime?.startsWith("audio/")
      ? "voice"
      : mime?.startsWith("video/")
        ? "video"
        : "file";
  return { kind, path: filePath, name: path.basename(filePath), ...(mime ? { mime } : {}) };
}

export class ChannelManager {
  private readonly server: RpcServer;
  private readonly config: ChannelConfigStore;
  private readonly state: ChannelStateStore;
  private readonly registry: AdapterRegistry;
  private readonly lanes = new LaneScheduler();
  private readonly media: ChannelMediaStore;
  private readonly bridge: Pick<
    PiSessionBridge,
    "getSessionStatus" | "newSession" | "runCommand" | "runTurn" | "syncTools"
  >;
  private readonly secretAccess: SecretAccess;
  private readonly runtimes = new Map<string, RuntimeEntry>();
  private readonly starting = new Map<string, StartingEntry>();
  private readonly statuses = new Map<string, ChannelStatus>();
  private readonly loginWaits = new Map<string, Promise<ChannelLoginEvent>>();
  private readonly loginWaitCleanupTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private initialized: Promise<void> | null = null;

  constructor(
    server: RpcServer,
    bindSessionEvents: (session: AgentSessionWrapper, sessionId: string) => void,
    options: ChannelManagerOptions = {},
  ) {
    this.server = server;
    const base = options.dataDirectory ?? userDataPath();
    this.config = new ChannelConfigStore(path.join(base, "channels.json"));
    this.state = new ChannelStateStore(path.join(base, "channels.state.json"));
    this.media = new ChannelMediaStore(path.join(base, "channel-media"));
    this.registry = options.registry ?? new AdapterRegistry();
    this.bridge = options.bridge ?? new PiSessionBridge(bindSessionEvents);
    this.secretAccess = options.secretAccess ?? {
      get: async (channel, accountId) => {
        const value = await callMain<unknown>("channelSecrets.get", { key: secretKey(channel, accountId) });
        return isChannelSecret(value) ? value : null;
      },
      set: async (channel, accountId, secret) => {
        await callMain("channelSecrets.set", { key: secretKey(channel, accountId), value: secret });
      },
      delete: async (channel, accountId) => {
        await callMain("channelSecrets.delete", { key: secretKey(channel, accountId) });
      },
    };
    for (const account of this.config.listAccounts()) {
      this.statuses.set(account.id, {
        channel: account.channel,
        accountId: account.id,
        state: "stopped",
        connected: false,
      });
    }
  }

  initialize(): Promise<void> {
    if (!this.initialized) {
      const attempt = (async () => {
        await this.media.initialize();
        for (const account of this.config.listAccounts()) {
          if (account.enabled) await this.startAccount(account.id).catch(() => undefined);
        }
      })();
      this.initialized = attempt;
      void attempt.catch(() => {
        if (this.initialized === attempt) this.initialized = null;
      });
    }
    return this.initialized;
  }

  private log(message: string): void {
    try {
      process.parentPort?.postMessage({ type: "log", message: `[channels] ${message}` });
    } catch {
      /* ignore */
    }
  }

  private emitStatus(account: ChannelAccountConfig, patch: Partial<ChannelStatus>): void {
    const current = this.statuses.get(account.id) ?? {
      channel: account.channel,
      accountId: account.id,
      state: "stopped" as const,
      connected: false,
    };
    const next: ChannelStatus = { ...current, ...patch, channel: account.channel, accountId: account.id };
    this.statuses.set(account.id, next);
    this.server.emit("channels.status", account.id, next);
  }

  private addActivity(activity: Omit<ChannelActivity, "id" | "at">): void {
    const full: ChannelActivity = { ...activity, id: randomUUID(), at: new Date().toISOString() };
    this.state.addActivity(full);
    this.server.emit("channels.activity", activity.accountId, full);
  }

  private async getSecret(account: Pick<ChannelAccountConfig, "channel" | "id">): Promise<ChannelSecret | null> {
    return this.secretAccess.get(account.channel, account.id);
  }

  private async setSecret(channel: ChannelId, accountId: string, secret: ChannelSecret): Promise<void> {
    await this.secretAccess.set(channel, accountId, secret);
  }

  private async deleteSecret(account: Pick<ChannelAccountConfig, "channel" | "id">): Promise<void> {
    await this.secretAccess.delete(account.channel, account.id);
  }

  async snapshot(): Promise<ChannelsSnapshot> {
    await this.initialize();
    const accounts: ChannelAccountView[] = await Promise.all(
      this.config.listAccounts().map(async (account) => {
        try {
          const secret = await this.getSecret(account);
          return {
            ...account,
            configured: Boolean(secret),
            ...(secret ? { credentialFingerprint: fingerprintSecret(secret.token) } : {}),
          };
        } catch {
          return { ...account, configured: false };
        }
      }),
    );
    return {
      accounts,
      statuses: this.config.listAccounts().map(
        (account) =>
          this.statuses.get(account.id) ?? {
            channel: account.channel,
            accountId: account.id,
            state: "stopped",
            connected: false,
          },
      ),
      pairings: this.state.listPairings(),
      bindings: this.config.listBindings(),
      activities: this.state.listActivities(),
    };
  }

  async upsertAccount(account: ChannelAccountConfig): Promise<ChannelsSnapshot> {
    const previous = this.config.getAccount(account.id);
    const saved = this.config.upsertAccount(account);
    if (previous && !sameToolNames(previous.toolNames, saved.toolNames)) {
      const syncedSessionIds = new Set<string>();
      for (const binding of this.config.listBindings()) {
        if (binding.accountId !== saved.id) continue;
        const updatedBinding = this.config.upsertBinding({ ...binding, toolNames: saved.toolNames });
        this.server.emit("channels.binding", updatedBinding.id, {
          action: "upsert",
          bindingId: updatedBinding.id,
          binding: updatedBinding,
        });
        if (!updatedBinding.sessionId || syncedSessionIds.has(updatedBinding.sessionId)) continue;
        syncedSessionIds.add(updatedBinding.sessionId);
        await this.bridge.syncTools(updatedBinding, saved.toolNames);
      }
    }
    if (saved.enabled) await this.restartAccount(saved.id);
    else await this.stopAccount(saved.id);
    return this.snapshot();
  }

  async connectAccount(account: ChannelAccountConfig): Promise<ChannelsSnapshot> {
    if (this.config.getAccount(account.id)) throw new Error("消息渠道账号已存在，请使用凭证更新功能");
    const secret = await this.getSecret(account);
    if (!secret) throw new Error("消息渠道凭证尚未写入系统安全存储");

    try {
      const probe = await this.registry.get(account.channel).probe(account, secret);
      if (!probe.ok) throw new Error(probe.message);
      const providerAccountId = probe.providerAccountId ?? secret.providerAccountId;
      const providerUsername = probe.providerUsername ?? secret.providerUsername;
      await this.setSecret(account.channel, account.id, {
        ...secret,
        providerAccountId,
        ...(providerUsername ? { providerUsername } : {}),
      });
      const saved = this.config.upsertAccount({
        ...account,
        name: account.name.trim() || providerUsername || probe.displayName || `${account.channel} ${providerAccountId}`,
        enabled: true,
        providerAccountId,
        ...(providerUsername ? { providerUsername } : {}),
        updatedAt: new Date().toISOString(),
      });
      await this.restartAccount(saved.id);
      return this.snapshot();
    } catch (error) {
      await this.deleteSecret(account).catch(() => undefined);
      this.config.deleteAccount(account.id);
      this.state.deleteAccount(account.id);
      this.statuses.delete(account.id);
      throw error;
    }
  }

  async deleteAccount(accountId: string): Promise<ChannelsSnapshot> {
    const account = this.config.getAccount(accountId);
    await this.stopAccount(accountId);
    if (account) await this.deleteSecret(account);
    this.config.deleteAccount(accountId);
    this.state.deleteAccount(accountId);
    this.statuses.delete(accountId);
    return this.snapshot();
  }

  async startAccount(accountId: string): Promise<void> {
    const account = this.config.getAccount(accountId);
    if (!account) throw new Error("Channel account not found");
    if (!account.enabled) throw new Error("Channel account is disabled");
    if (this.runtimes.has(accountId)) return;
    const pending = this.starting.get(accountId);
    if (pending) return pending.task;
    const controller = new AbortController();
    const task = this.startAccountRuntime(account, controller);
    const entry = { controller, task };
    this.starting.set(accountId, entry);
    try {
      await task;
    } finally {
      if (this.starting.get(accountId) === entry) this.starting.delete(accountId);
    }
  }

  private async startAccountRuntime(account: ChannelAccountConfig, controller: AbortController): Promise<void> {
    const secret = await this.getSecret(account);
    if (controller.signal.aborted) return;
    if (!secret) {
      const message = "消息渠道账号尚未配置凭证";
      this.emitStatus(account, { state: "error", connected: false, lastError: message });
      throw new Error(message);
    }
    const adapter = this.registry.get(account.channel);
    this.emitStatus(account, { state: "starting", connected: false, lastError: undefined });
    const task = adapter
      .start({
        account,
        secret,
        signal: controller.signal,
        state: this.state,
        onInbound: (envelope) => this.handleInbound(envelope),
        onStatus: (patch) => this.emitStatus(account, patch),
        log: (message) => this.log(`[${account.id}] ${message}`),
      })
      .catch((error) => {
        if (!controller.signal.aborted) {
          const message = safeChannelError(error);
          this.emitStatus(account, { state: "error", connected: false, lastError: message });
          this.addActivity({
            channel: account.channel,
            accountId: account.id,
            direction: "system",
            outcome: "failed",
            detail: message,
          });
        }
      })
      .finally(() => {
        if (this.runtimes.get(account.id)?.controller === controller) this.runtimes.delete(account.id);
      });
    this.runtimes.set(account.id, { controller, task });
  }

  async stopAccount(accountId: string): Promise<void> {
    const starting = this.starting.get(accountId);
    if (starting) {
      starting.controller.abort();
      await starting.task.catch(() => undefined);
      if (this.starting.get(accountId) === starting) this.starting.delete(accountId);
    }
    const runtime = this.runtimes.get(accountId);
    if (runtime) {
      runtime.controller.abort();
      await Promise.race([runtime.task, new Promise<void>((resolve) => setTimeout(resolve, 2_000))]);
      this.runtimes.delete(accountId);
    }
    const account = this.config.getAccount(accountId);
    if (account) this.emitStatus(account, { state: "stopped", connected: false });
  }

  async restartAccount(accountId: string): Promise<void> {
    await this.stopAccount(accountId);
    const account = this.config.getAccount(accountId);
    if (account?.enabled) await this.startAccount(accountId);
  }

  async probe(accountId: string): Promise<ChannelProbeResult> {
    const account = this.config.getAccount(accountId);
    if (!account) throw new Error("Channel account not found");
    const secret = await this.getSecret(account);
    if (!secret) return { ok: false, message: "消息渠道账号尚未配置凭证", accountId };
    return this.registry.get(account.channel).probe(account, secret);
  }

  async startLogin(request: ChannelLoginStartRequest): Promise<ChannelLoginEvent> {
    const channel = request.channel;
    const adapter = this.registry.get(channel);
    if (!adapter.startLogin) throw new Error(`${channel} does not use interactive login`);
    const localTokens: string[] = [];
    if (channel === "weixin") {
      for (const account of this.config.listAccounts().filter((item) => item.channel === channel)) {
        const secret = await this.getSecret(account).catch(() => null);
        if (secret?.token) localTokens.push(secret.token);
      }
    }
    const event = await adapter.startLogin({ ...request, localTokens: localTokens.slice(-10) });
    this.server.emit("channels.login", event.sessionKey, event);
    return event;
  }

  waitLogin(channel: ChannelId, sessionKey: string): Promise<ChannelLoginEvent> {
    const key = `${channel}\0${sessionKey}`;
    const existing = this.loginWaits.get(key);
    if (existing) return existing;

    const pending = this.waitLoginOnce(channel, sessionKey);
    this.loginWaits.set(key, pending);
    void pending.then(
      (event) => {
        if (this.loginWaits.get(key) !== pending) return;
        if (event.phase !== "confirmed") {
          this.loginWaits.delete(key);
          return;
        }
        const timer = setTimeout(() => {
          if (this.loginWaits.get(key) === pending) this.loginWaits.delete(key);
          this.loginWaitCleanupTimers.delete(key);
        }, LOGIN_SUCCESS_RETENTION_MS);
        timer.unref?.();
        this.loginWaitCleanupTimers.set(key, timer);
      },
      () => {
        if (this.loginWaits.get(key) === pending) this.loginWaits.delete(key);
      },
    );
    return pending;
  }

  private async waitLoginOnce(channel: ChannelId, sessionKey: string): Promise<ChannelLoginEvent> {
    const pollLogin = this.registry.get(channel).pollLogin;
    if (!pollLogin) throw new Error(`${channel} does not use interactive login`);
    const result = await pollLogin.call(this.registry.get(channel), sessionKey);
    if (result.credential && result.event.accountId) {
      try {
        const accountId = result.event.accountId;
        const now = new Date().toISOString();
        const existing = this.config.getAccount(accountId);
        const previousSecret = await this.getSecret({ channel, id: accountId }).catch(() => null);
        const ownerUserId = result.account?.ownerUserId?.trim();
        const appId = result.account?.appId?.trim();
        const domain = result.account?.domain;
        if (channel === "feishu") {
          const expectedAccountId =
            appId && domain
              ? `feishu-${createHash("sha256").update(`${domain}\0${appId}`).digest("hex").slice(0, 24)}`
              : "";
          if (!appId || !/^cli_[A-Za-z0-9]+$/.test(appId) || !domain || expectedAccountId !== accountId) {
            const event: ChannelLoginEvent = {
              channel,
              sessionKey,
              phase: "error",
              message: "飞书/Lark 返回的应用信息无效，请重新扫码。",
            };
            this.server.emit("channels.login", sessionKey, event);
            return event;
          }
        }
        const allowFrom = new Set(existing?.allowFrom ?? []);
        if (ownerUserId) allowFrom.add(ownerUserId);
        const baseUrl =
          channel === "feishu"
            ? domain === "lark"
              ? "https://open.larksuite.com"
              : "https://open.feishu.cn"
            : result.credential.baseUrl;
        const credential: ChannelSecret = { ...result.credential, baseUrl };
        const provisional: ChannelAccountConfig = {
          id: accountId,
          channel,
          name:
            existing?.name || result.account?.displayName || `${channelDisplayName(channel)} ${accountId.slice(-6)}`,
          enabled: true,
          ...(channel !== "feishu" ? { providerAccountId: credential.providerAccountId } : {}),
          ...(credential.providerUsername ? { providerUsername: credential.providerUsername } : {}),
          ...(ownerUserId ? { userId: ownerUserId } : {}),
          baseUrl,
          ...(channel === "feishu" && appId ? { appId } : {}),
          ...(channel === "feishu" && domain ? { domain } : {}),
          dmPolicy: existing?.dmPolicy ?? (channel === "feishu" && ownerUserId ? "allowlist" : "pairing"),
          allowFrom: [...allowFrom],
          groupPolicy: existing?.groupPolicy ?? "disabled",
          groupIds: existing?.groupIds ?? [],
          groupAllowFrom: existing?.groupAllowFrom ?? [],
          requireMention: existing?.requireMention ?? true,
          commandsEnabled: existing?.commandsEnabled ?? false,
          ...(existing?.defaultCwd ? { defaultCwd: existing.defaultCwd } : {}),
          toolNames: existing?.toolNames ?? [],
          createdAt: existing?.createdAt ?? now,
          updatedAt: now,
        };
        try {
          await this.setSecret(channel, accountId, credential);
          this.config.upsertAccount(provisional);
        } catch {
          if (previousSecret) await this.setSecret(channel, accountId, previousSecret).catch(() => undefined);
          else await this.secretAccess.delete(channel, accountId).catch(() => undefined);
          try {
            if (existing) this.config.upsertAccount(existing);
            else this.config.deleteAccount(accountId);
          } catch {
            /* The original persistence error remains authoritative. */
          }
          const event: ChannelLoginEvent = {
            channel,
            sessionKey,
            phase: "error",
            message: "应用已创建，但安全保存失败。请在飞书/Lark 后台删除该应用后重试。",
            accountId,
          };
          this.server.emit("channels.login", sessionKey, event);
          return event;
        }

        const probe = await this.registry
          .get(channel)
          .probe(provisional, credential)
          .catch(() => ({ ok: false as const, accountId, message: "无法验证机器人身份，请检查网络后重试。" }));
        if (!probe.ok) {
          const probeMessage = safeChannelError(probe.message).split(credential.token).join("[REDACTED]");
          const message = `应用已创建并安全保存，但连接检查失败：${probeMessage}`;
          this.emitStatus(provisional, { state: "error", connected: false, lastError: message });
          const event: ChannelLoginEvent = { channel, sessionKey, phase: "error", message, accountId };
          this.server.emit("channels.login", sessionKey, event);
          return event;
        }

        const providerAccountId = probe.providerAccountId ?? credential.providerAccountId;
        const providerUsername = probe.providerUsername ?? credential.providerUsername;
        const savedSecret: ChannelSecret = {
          ...credential,
          providerAccountId,
          ...(providerUsername ? { providerUsername } : {}),
        };
        try {
          await this.setSecret(channel, accountId, savedSecret);
          this.config.upsertAccount({
            ...provisional,
            name:
              existing?.name ||
              providerUsername ||
              probe.displayName ||
              result.account?.displayName ||
              provisional.name,
            providerAccountId,
            ...(providerUsername ? { providerUsername } : {}),
            updatedAt: new Date().toISOString(),
          });
          await this.restartAccount(accountId);
        } catch {
          const event: ChannelLoginEvent = {
            channel,
            sessionKey,
            phase: "error",
            message: "应用已创建并安全保存，但机器人启动失败。账号已保留，可稍后重试。",
            accountId,
          };
          this.server.emit("channels.login", sessionKey, event);
          return event;
        }
        result.event = {
          ...result.event,
          message: channel === "feishu" ? "飞书/Lark 机器人已创建并连接。" : result.event.message,
        };
      } finally {
        result.finalize?.();
      }
    }
    this.server.emit("channels.login", sessionKey, result.event);
    return result.event;
  }

  submitLoginCode(channel: ChannelId, sessionKey: string, code: string): void {
    const submit = this.registry.get(channel).submitLoginCode;
    if (!submit) throw new Error(`${channel} does not accept login verification codes`);
    submit.call(this.registry.get(channel), sessionKey, code);
  }

  cancelLogin(channel: ChannelId, sessionKey: string): void {
    const cancel = this.registry.get(channel).cancelLogin;
    if (!cancel) throw new Error(`${channel} does not use interactive login`);
    cancel.call(this.registry.get(channel), sessionKey);
    const event: ChannelLoginEvent = {
      channel,
      sessionKey,
      phase: "cancelled",
      message: "登录已取消。",
    };
    this.server.emit("channels.login", sessionKey, event);
  }

  async approvePairing(pairingId: string): Promise<ChannelsSnapshot> {
    const pairing = this.state.removePairing(pairingId);
    if (!pairing) throw new Error("Pairing request not found or expired");
    const account = this.config.getAccount(pairing.accountId);
    if (!account) throw new Error("Channel account not found");
    if (!account.allowFrom.includes(pairing.peerId)) account.allowFrom.push(pairing.peerId);
    this.config.upsertAccount(account);
    const secret = await this.getSecret(account).catch(() => null);
    const contextToken = this.state.getContextToken(account.id, pairing.peerId);
    if (secret && (account.channel !== "weixin" || contextToken)) {
      await this.registry
        .get(account.channel)
        .send({
          account,
          secret,
          peerId: pairing.peerId,
          contextToken,
          text: "Pi Agent Desktop 配对已批准，现在可以开始对话。",
        })
        .catch((error) => {
          this.log(`[${account.id}] pairing approval notification failed: ${safeChannelError(error)}`);
        });
    }
    return this.snapshot();
  }

  async rejectPairing(pairingId: string): Promise<ChannelsSnapshot> {
    if (!this.state.removePairing(pairingId)) throw new Error("Pairing request not found or expired");
    return this.snapshot();
  }

  async upsertBinding(binding: ChannelBinding): Promise<ChannelsSnapshot> {
    const saved = this.config.upsertBinding(binding);
    this.server.emit("channels.binding", saved.id, { action: "upsert", bindingId: saved.id, binding: saved });
    return this.snapshot();
  }

  async deleteBinding(bindingIdValue: string): Promise<ChannelsSnapshot> {
    this.config.deleteBinding(bindingIdValue);
    this.server.emit("channels.binding", bindingIdValue, { action: "delete", bindingId: bindingIdValue });
    return this.snapshot();
  }

  async testSend(accountId: string, peerId: string, message: string): Promise<{ ok: true; messageId: string }> {
    const account = this.config.getAccount(accountId);
    if (!account) throw new Error("Channel account not found");
    const secret = await this.getSecret(account);
    if (!secret) throw new Error("Channel credential is unavailable");
    const contextToken = this.state.getContextToken(accountId, peerId);
    if (account.channel === "weixin" && !contextToken) {
      throw new Error("该用户尚未向机器人发送消息，无法建立回复上下文");
    }
    const receipt = await this.registry
      .get(account.channel)
      .send({ account, secret, peerId, text: message, contextToken });
    this.state.addDelivery(receipt);
    return { ok: true, messageId: receipt.messageId };
  }

  private resolveBinding(account: ChannelAccountConfig, envelope: InboundEnvelope): ChannelBinding {
    const bindings = this.config.listBindings();
    const exact = bindings.find(
      (binding) =>
        binding.channel === envelope.channel &&
        binding.accountId === envelope.accountId &&
        binding.peerKind === envelope.peer.kind &&
        binding.peerId === envelope.peer.id &&
        (binding.threadId ?? "") === (envelope.threadId ?? ""),
    );
    if (exact) return exact;
    const peerBinding = bindings.find(
      (binding) =>
        binding.channel === envelope.channel &&
        binding.accountId === envelope.accountId &&
        binding.peerKind === envelope.peer.kind &&
        binding.peerId === envelope.peer.id &&
        !binding.threadId,
    );
    if (peerBinding) return peerBinding;
    const now = new Date().toISOString();
    const cwd =
      account.defaultCwd ??
      path.join(
        userDataPath(),
        "channel-workspaces",
        envelope.channel,
        account.id,
        workspaceSegment(routeKey(envelope)),
      );
    const created = this.config.upsertBinding({
      id: bindingId(envelope),
      channel: envelope.channel,
      accountId: envelope.accountId,
      peerKind: envelope.peer.kind,
      peerId: envelope.peer.id,
      ...(envelope.threadId ? { threadId: envelope.threadId } : {}),
      cwd,
      toolNames: account.toolNames,
      createdAt: now,
      lastUsedAt: now,
    });
    this.server.emit("channels.binding", created.id, {
      action: "upsert",
      bindingId: created.id,
      binding: created,
    });
    return created;
  }

  private saveBindingSession(binding: ChannelBinding, sessionId: string): ChannelBinding {
    if (binding.sessionId === sessionId) return binding;
    binding.sessionId = sessionId;
    binding.lastUsedAt = new Date().toISOString();
    const saved = this.config.upsertBinding(binding);
    this.server.emit("channels.binding", saved.id, {
      action: "upsert",
      bindingId: saved.id,
      binding: saved,
    });
    return saved;
  }

  private async handleCommand(
    account: ChannelAccountConfig,
    binding: ChannelBinding,
    command: ParsedChannelCommand,
  ): Promise<{ finalText: string; sessionId?: string; notifySession?: boolean }> {
    if (command.name !== "compact" && command.args) {
      return { finalText: `用法：/${command.name}` };
    }

    if (command.name === "help") return { finalText: channelCommandHelpText() };

    if (command.name === "status") {
      const runtime = this.statuses.get(account.id);
      const session = this.bridge.getSessionStatus(binding);
      const channelName = channelDisplayName(account.channel);
      return {
        finalText: [
          `渠道：${channelName} · ${runtime?.connected ? "已连接" : "未连接"}`,
          `会话：${session.hasSession ? "已绑定" : "尚未创建"}`,
          `Agent：${session.running ? "处理中" : "空闲"}`,
          "IM 命令：已启用",
        ].join("\n"),
      };
    }

    if (command.name === "new") {
      const created = await this.bridge.newSession(binding, account.toolNames);
      return {
        sessionId: created.sessionId,
        notifySession: true,
        finalText: "已开始新的独立会话，后续消息将使用新的上下文。",
      };
    }

    if (!binding.sessionId) {
      return {
        finalText: command.name === "compact" ? "当前还没有可压缩的会话。" : "当前还没有可重新加载的会话。",
      };
    }

    const result = await this.bridge.runCommand(
      binding,
      command.name,
      command.name === "compact" && command.args ? command.args : undefined,
    );
    return {
      sessionId: result.sessionId,
      notifySession: true,
      finalText: command.name === "compact" ? "当前会话上下文已压缩。" : "已重新加载扩展、Skills、Prompts 和工具。",
    };
  }

  private async handlePairing(
    account: ChannelAccountConfig,
    envelope: InboundEnvelope,
    secret: ChannelSecret,
  ): Promise<void> {
    let pairing = this.state.findPairing(account.id, envelope.sender.id);
    let created = false;
    if (!pairing) {
      const now = Date.now();
      pairing = {
        id: randomUUID(),
        code: String(randomInt(100_000, 1_000_000)),
        channel: account.channel,
        accountId: account.id,
        peerId: envelope.sender.id,
        createdAt: new Date(now).toISOString(),
        expiresAt: new Date(now + PAIRING_TTL_MS).toISOString(),
      };
      this.state.upsertPairing(pairing);
      this.server.emit("channels.pairing", account.id, pairing);
      created = true;
    }
    if (!created) return;
    const receipt = await this.registry.get(account.channel).send({
      account,
      secret,
      peerId: envelope.peer.id,
      contextToken: envelope.providerContext?.contextToken,
      threadId: envelope.threadId,
      replyToMessageId: envelope.providerContext?.replyToMessageId,
      text: `Pi Agent Desktop 配对码：${pairing.code}\n请在桌面应用的“设置 → 消息渠道”中批准此请求。`,
    });
    this.state.addDelivery(receipt);
  }

  private async handleInbound(envelope: InboundEnvelope): Promise<void> {
    await this.lanes.run(routeKey(envelope), async () => {
      const account = this.config.getAccount(envelope.accountId);
      if (!account || !account.enabled) return;
      const secret = await this.getSecret(account);
      if (!secret) throw new Error("Channel credential is unavailable");
      const decision = evaluateInboundPolicy(account, envelope);
      if (decision === "ignore") {
        this.addActivity({
          channel: account.channel,
          accountId: account.id,
          direction: "inbound",
          outcome: "ignored",
          peerId: envelope.peer.id,
          detail: "访问策略拒绝",
        });
        return;
      }
      if (decision === "pair") {
        await this.handlePairing(account, envelope, secret);
        this.addActivity({
          channel: account.channel,
          accountId: account.id,
          direction: "inbound",
          outcome: "ignored",
          peerId: envelope.peer.id,
          detail: "等待配对批准",
        });
        return;
      }
      if (!envelope.text.trim() && envelope.attachments.length === 0) {
        const label = "消息内容为空。";
        const receipt = await this.registry.get(account.channel).send({
          account,
          secret,
          peerId: envelope.peer.id,
          contextToken: envelope.providerContext?.contextToken,
          threadId: envelope.threadId,
          replyToMessageId: envelope.providerContext?.replyToMessageId,
          text: label,
        });
        this.state.addDelivery(receipt);
        return;
      }

      const binding = this.resolveBinding(account, envelope);
      const adapter = this.registry.get(account.channel);
      let stagedAttachments: StagedInboundAttachment[] = [];
      if (envelope.attachments.length > 0 && adapter.downloadInbound) {
        try {
          if (envelope.attachments.length > CHANNEL_MEDIA_MAX_ATTACHMENTS) {
            throw new Error(`单条消息最多支持 ${CHANNEL_MEDIA_MAX_ATTACHMENTS} 个附件`);
          }
          const downloaded = await adapter.downloadInbound({ account, secret, envelope });
          stagedAttachments = await this.media.stage(account.id, envelope.id, downloaded);
        } catch (error) {
          this.log(`[${account.id}] media download failed: ${safeChannelError(error)}`);
          const receipt = await adapter.send({
            account,
            secret,
            peerId: envelope.peer.id,
            contextToken: envelope.providerContext?.contextToken,
            threadId: envelope.threadId,
            replyToMessageId: envelope.providerContext?.replyToMessageId,
            text: "附件下载或校验失败。请确认文件不超过 20 MiB，并重新发送受支持的图片、文件或语音。",
          });
          this.state.addDelivery(receipt);
          this.addActivity({
            channel: account.channel,
            accountId: account.id,
            direction: "inbound",
            outcome: "ignored",
            peerId: envelope.peer.id,
            detail: "附件处理失败",
          });
          return;
        }
      }
      if (!envelope.text.trim() && stagedAttachments.length === 0) {
        const receipt = await adapter.send({
          account,
          secret,
          peerId: envelope.peer.id,
          contextToken: envelope.providerContext?.contextToken,
          threadId: envelope.threadId,
          replyToMessageId: envelope.providerContext?.replyToMessageId,
          text: "当前渠道或消息类型尚不支持该媒体附件。",
        });
        this.state.addDelivery(receipt);
        return;
      }
      this.addActivity({
        channel: account.channel,
        accountId: account.id,
        direction: "inbound",
        outcome: "accepted",
        peerId: envelope.peer.id,
      });
      await adapter
        .setTyping?.({
          account,
          secret,
          peerId: envelope.peer.id,
          contextToken: envelope.providerContext?.contextToken,
          threadId: envelope.threadId,
          typing: true,
        })
        .catch(() => undefined);
      let progressiveOutput: AdapterTurnOutput | undefined;
      try {
        const command = account.commandsEnabled === true ? parseChannelCommand(envelope.text) : null;
        progressiveOutput = command
          ? undefined
          : adapter.beginTurn?.({
              account,
              secret,
              peerId: envelope.peer.id,
              peerKind: envelope.peer.kind,
              contextToken: envelope.providerContext?.contextToken,
              threadId: envelope.threadId,
              replyToMessageId: envelope.providerContext?.replyToMessageId,
              runId: envelope.id,
            });
        const turn = command
          ? await this.handleCommand(account, binding, command)
          : {
              ...(await this.bridge.runTurn(
                binding,
                envelope,
                (event) => progressiveOutput?.update(event),
                stagedAttachments,
                account.toolNames,
              )),
              notifySession: true,
            };
        if (turn.sessionId) this.saveBindingSession(binding, turn.sessionId);
        // Notify on every external turn, not only when a binding first gains a
        // session id. The active desktop chat uses this durable signal to
        // reload messages if the live agent stream was idle or interrupted.
        if (turn.notifySession && turn.sessionId) {
          const sessionCwd = "cwd" in turn && typeof turn.cwd === "string" ? turn.cwd : binding.cwd;
          const sessionPath = await resolveSessionPath(turn.sessionId).catch(() => null);
          const session = sessionPath ? await sessionIndex.refreshPath(sessionPath).catch(() => null) : null;
          if (session) {
            this.server.emit("sessions.changed", session.id, {
              cwd: session.cwd,
              sessionId: session.id,
              session,
            });
          } else {
            this.server.emit("sessions.changed", "*", {
              cwd: sessionCwd,
              sessionId: turn.sessionId,
              fullRefresh: true,
            });
          }
        }
        const text = turn.finalText || "Agent 已完成处理，但没有生成文本回复。";
        const receipt = progressiveOutput
          ? await progressiveOutput.finish(text)
          : await adapter.send({
              account,
              secret,
              peerId: envelope.peer.id,
              contextToken: envelope.providerContext?.contextToken,
              threadId: envelope.threadId,
              replyToMessageId: envelope.providerContext?.replyToMessageId,
              text,
              runId: envelope.id,
            });
        this.state.addDelivery(receipt);
        const generatedFiles =
          "generatedFiles" in turn && Array.isArray(turn.generatedFiles)
            ? turn.generatedFiles.filter((filePath): filePath is string => typeof filePath === "string")
            : [];
        if (
          !command &&
          generatedFiles.length > 0 &&
          (account.channel === "weixin" || account.channel === "telegram" || account.channel === "feishu")
        ) {
          try {
            const mediaReceipt = await adapter.send({
              account,
              secret,
              peerId: envelope.peer.id,
              contextToken: envelope.providerContext?.contextToken,
              threadId: envelope.threadId,
              ...(account.channel === "feishu" && envelope.providerContext?.replyToMessageId
                ? { replyToMessageId: envelope.providerContext.replyToMessageId }
                : {}),
              attachments: generatedFiles.map(outboundAttachment),
              text: "",
              runId: envelope.id,
            });
            this.state.addDelivery(mediaReceipt);
          } catch (error) {
            this.log(`[${account.id}] generated file delivery failed: ${safeChannelError(error)}`);
            this.addActivity({
              channel: account.channel,
              accountId: account.id,
              direction: "outbound",
              outcome: "failed",
              peerId: envelope.peer.id,
              detail: "生成文件发送失败",
            });
          }
        }
        this.emitStatus(account, { lastOutboundAt: Date.now(), lastEventAt: Date.now() });
        this.addActivity({
          channel: account.channel,
          accountId: account.id,
          direction: "outbound",
          outcome: "sent",
          peerId: envelope.peer.id,
        });
      } catch (error) {
        await progressiveOutput?.cancel().catch(() => undefined);
        const message = safeChannelError(error);
        this.addActivity({
          channel: account.channel,
          accountId: account.id,
          direction: "outbound",
          outcome: "failed",
          peerId: envelope.peer.id,
          detail: message,
        });
        throw error;
      } finally {
        await adapter
          .setTyping?.({
            account,
            secret,
            peerId: envelope.peer.id,
            contextToken: envelope.providerContext?.contextToken,
            threadId: envelope.threadId,
            typing: false,
          })
          .catch(() => undefined);
      }
    });
  }

  async shutdown(): Promise<void> {
    for (const accountId of [...this.runtimes.keys()]) await this.stopAccount(accountId);
    for (const timer of this.loginWaitCleanupTimers.values()) clearTimeout(timer);
    this.loginWaitCleanupTimers.clear();
    this.loginWaits.clear();
    await this.media.dispose();
  }
}
