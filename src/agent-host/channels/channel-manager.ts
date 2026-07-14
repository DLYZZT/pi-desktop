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
import { callMain } from "../parent-rpc";
import { PiSessionBridge } from "./pi-session-bridge";
import { evaluateInboundPolicy } from "./policy";
import { fingerprintSecret, safeChannelError } from "./redaction";
import { ChannelStateStore } from "./state-store";
import type { AdapterTurnOutput, ChannelSecret } from "./types";

type RuntimeEntry = { controller: AbortController; task: Promise<void> };
type SecretAccess = {
  get: (channel: ChannelId, accountId: string) => Promise<ChannelSecret | null>;
  set: (channel: ChannelId, accountId: string, secret: ChannelSecret) => Promise<void>;
  delete: (channel: ChannelId, accountId: string) => Promise<void>;
};

export type ChannelManagerOptions = {
  dataDirectory?: string;
  registry?: AdapterRegistry;
  secretAccess?: SecretAccess;
  bridge?: Pick<PiSessionBridge, "getSessionStatus" | "newSession" | "runCommand" | "runTurn">;
};

const PAIRING_TTL_MS = 10 * 60_000;

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

export class ChannelManager {
  private readonly server: RpcServer;
  private readonly config: ChannelConfigStore;
  private readonly state: ChannelStateStore;
  private readonly registry: AdapterRegistry;
  private readonly lanes = new LaneScheduler();
  private readonly bridge: Pick<PiSessionBridge, "getSessionStatus" | "newSession" | "runCommand" | "runTurn">;
  private readonly secretAccess: SecretAccess;
  private readonly runtimes = new Map<string, RuntimeEntry>();
  private readonly statuses = new Map<string, ChannelStatus>();
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
      this.initialized = (async () => {
        for (const account of this.config.listAccounts()) {
          if (account.enabled) await this.startAccount(account.id).catch(() => undefined);
        }
      })();
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
    const saved = this.config.upsertAccount(account);
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
    const secret = await this.getSecret(account);
    if (!secret) {
      const message = "消息渠道账号尚未配置凭证";
      this.emitStatus(account, { state: "error", connected: false, lastError: message });
      throw new Error(message);
    }
    const controller = new AbortController();
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
        if (this.runtimes.get(accountId)?.controller === controller) this.runtimes.delete(accountId);
      });
    this.runtimes.set(accountId, { controller, task });
  }

  async stopAccount(accountId: string): Promise<void> {
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

  async startLogin(channel: ChannelId, force?: boolean): Promise<ChannelLoginEvent> {
    const adapter = this.registry.get(channel);
    if (!adapter.startLogin) throw new Error(`${channel} does not use interactive login`);
    const localTokens: string[] = [];
    for (const account of this.config.listAccounts().filter((item) => item.channel === channel)) {
      const secret = await this.getSecret(account).catch(() => null);
      if (secret?.token) localTokens.push(secret.token);
    }
    const event = await adapter.startLogin(force, localTokens.slice(-10));
    this.server.emit("channels.login", event.sessionKey, event);
    return event;
  }

  async waitLogin(channel: ChannelId, sessionKey: string): Promise<ChannelLoginEvent> {
    const pollLogin = this.registry.get(channel).pollLogin;
    if (!pollLogin) throw new Error(`${channel} does not use interactive login`);
    const result = await pollLogin.call(this.registry.get(channel), sessionKey);
    if (result.credential && result.event.accountId) {
      const accountId = result.event.accountId;
      await this.setSecret(channel, accountId, result.credential);
      const now = new Date().toISOString();
      const existing = this.config.getAccount(accountId);
      const allowFrom = new Set(existing?.allowFrom ?? []);
      if (result.credential.userId) allowFrom.add(result.credential.userId);
      this.config.upsertAccount({
        id: accountId,
        channel,
        name: existing?.name || (channel === "weixin" ? `微信 ${accountId.slice(-6)}` : `Telegram ${accountId}`),
        enabled: true,
        providerAccountId: result.credential.providerAccountId,
        ...(result.credential.providerUsername ? { providerUsername: result.credential.providerUsername } : {}),
        ...(result.credential.userId ? { userId: result.credential.userId } : {}),
        baseUrl: result.credential.baseUrl,
        dmPolicy: existing?.dmPolicy ?? "pairing",
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
      });
      await this.restartAccount(accountId);
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
      const channelName = account.channel === "weixin" ? "微信" : "Telegram";
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
      const created = await this.bridge.newSession(binding);
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
      if (!envelope.text.trim()) {
        const label = envelope.attachments.length > 0 ? "当前版本暂不支持处理该媒体消息。" : "消息内容为空。";
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

      this.addActivity({
        channel: account.channel,
        accountId: account.id,
        direction: "inbound",
        outcome: "accepted",
        peerId: envelope.peer.id,
      });
      const binding = this.resolveBinding(account, envelope);
      const adapter = this.registry.get(account.channel);
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
              ...(await this.bridge.runTurn(binding, envelope, (event) => progressiveOutput?.update(event))),
              notifySession: true,
            };
        if (turn.sessionId) this.saveBindingSession(binding, turn.sessionId);
        // Notify on every external turn, not only when a binding first gains a
        // session id. The active desktop chat uses this durable signal to
        // reload messages if the live agent stream was idle or interrupted.
        if (turn.notifySession && turn.sessionId) {
          this.server.emit("sessions.changed", "*", { cwd: binding.cwd, sessionId: turn.sessionId });
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
  }
}
