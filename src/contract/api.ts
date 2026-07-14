import type {
  AgentCommand,
  AgentEvent,
  ContextInfo,
  DirEntry,
  FileContent,
  FileMeta,
  LoginProgressEvent,
  ModelsConfig,
  ModelsListResult,
  ProviderStatus,
  RunningStateEvent,
  SessionDetail,
  SessionInfo,
  TestResult,
  WorktreeInfo,
} from "./types";
import type {
  GitStatusResult,
  PluginActionParams,
  PluginsResponse,
  SkillRecord,
  SkillUpdateParams,
} from "../shared/api-types";
import type {
  ChannelAccountConfig,
  ChannelBinding,
  ChannelBindingChange,
  ChannelLoginEvent,
  ChannelProbeResult,
  ChannelsSnapshot,
  ChannelStatus,
  ChannelPairingRequest,
  ChannelActivity,
  ChannelId,
  ChannelTestSendResult,
} from "../shared/channel-types";

/** Request/response API surface (replaces HTTP routes). */
export interface Api {
  "host.ping": { params: void; result: { ok: true; ts: number } };

  // Sessions & projects
  "sessions.list": {
    params: { cwd?: string } | void;
    result: { sessions: SessionInfo[]; runningSessionIds: string[] };
  };
  "sessions.get": {
    params: { id: string; includeState?: boolean };
    result: SessionDetail;
  };
  "sessions.context": {
    params: { id: string; leafId?: string };
    result: { context: ContextInfo };
  };
  "sessions.export": {
    params: { id: string; format?: "md" | "json" };
    result: { content: string; suggestedName: string };
  };
  "sessions.delete": { params: { id: string; force?: boolean }; result: { ok: true } };
  "sessions.rename": {
    params: { id: string; name: string };
    result: { ok: true };
  };

  "worktrees.list": {
    params: { projectRoot: string };
    result: {
      worktrees: WorktreeInfo[];
      projectRoot: string;
      isGit: boolean;
      isTopLevel: boolean;
    };
  };
  "worktrees.create": {
    params: { projectRoot: string; branch: string; cwd?: string };
    result: { worktree: WorktreeInfo };
  };
  "worktrees.remove": {
    params: { path: string; cwd?: string; force?: boolean };
    result: { ok: true };
  };

  "git.status": {
    params: { path: string };
    result: GitStatusResult;
  };

  // Agent lifecycle
  "agent.new": {
    params: {
      cwd: string;
      type?: string;
      message?: string;
      provider?: string;
      modelId?: string;
      toolNames?: string[];
      thinkingLevel?: string;
      [key: string]: unknown;
    };
    result: { sessionId: string; data?: unknown };
  };
  "agent.command": {
    params: { sessionId: string; command: AgentCommand };
    result: unknown;
  };
  "agent.state": {
    params: { sessionId: string };
    result: { running: boolean; state?: unknown };
  };

  // Messaging channels
  "channels.list": { params: void; result: ChannelsSnapshot };
  "channels.accountUpsert": {
    params: { account: ChannelAccountConfig };
    result: ChannelsSnapshot;
  };
  "channels.accountConnect": {
    params: { account: ChannelAccountConfig };
    result: ChannelsSnapshot;
  };
  "channels.accountDelete": {
    params: { accountId: string };
    result: ChannelsSnapshot;
  };
  "channels.start": { params: { accountId: string }; result: { ok: true } };
  "channels.stop": { params: { accountId: string }; result: { ok: true } };
  "channels.restart": { params: { accountId: string }; result: { ok: true } };
  "channels.probe": { params: { accountId: string }; result: ChannelProbeResult };
  "channels.loginStart": {
    params: { channel: ChannelId; force?: boolean };
    result: ChannelLoginEvent;
  };
  "channels.loginWait": {
    params: { channel: ChannelId; sessionKey: string };
    result: ChannelLoginEvent;
  };
  "channels.loginSubmitCode": {
    params: { channel: ChannelId; sessionKey: string; code: string };
    result: { ok: true };
  };
  "channels.loginCancel": {
    params: { channel: ChannelId; sessionKey: string };
    result: { ok: true };
  };
  "channels.pairingApprove": {
    params: { pairingId: string };
    result: ChannelsSnapshot;
  };
  "channels.pairingReject": {
    params: { pairingId: string };
    result: ChannelsSnapshot;
  };
  "channels.bindingUpsert": {
    params: { binding: ChannelBinding };
    result: ChannelsSnapshot;
  };
  "channels.bindingDelete": {
    params: { bindingId: string };
    result: ChannelsSnapshot;
  };
  "channels.testSend": {
    params: { accountId: string; peerId: string; message: string };
    result: ChannelTestSendResult;
  };

  // Files
  "files.list": { params: { path: string }; result: { entries: DirEntry[] } };
  "files.read": {
    params: { path: string; sourceSessionId?: string };
    result: FileContent & {
      encoding?: "utf8" | "base64" | "too_large";
      mime?: string;
    };
  };
  "files.download": {
    params: { path: string; sourceSessionId?: string };
    result: { base64: string; size: number; mime: string };
  };
  "files.meta": {
    params: { path: string; sourceSessionId?: string };
    result: FileMeta;
  };
  "files.preview": {
    params: { path: string; sourceSessionId?: string };
    result: { kind: string; content?: string; base64?: string; mime?: string; [key: string]: unknown };
  };
  "files.index": {
    params: { root: string; query?: string };
    result: {
      files: string[];
      truncated: boolean;
      matches?: Array<{ path: string; isDir?: boolean; score?: number }>;
    };
  };
  "files.watchStart": {
    params: { path: string; sourceSessionId?: string };
    result: { ok: true };
  };
  "files.watchStop": {
    params: { path: string };
    result: { ok: true };
  };

  // Config
  "models.list": {
    params: { cwd?: string } | void;
    result: ModelsListResult;
  };
  "modelsConfig.get": { params: void; result: ModelsConfig };
  "modelsConfig.set": { params: ModelsConfig; result: { ok: true } };
  "modelsConfig.test": {
    params: {
      providerName?: string;
      provider?: Record<string, unknown>;
      model?: Record<string, unknown>;
      [key: string]: unknown;
    };
    result: TestResult;
  };

  "auth.providers": { params: void; result: { providers: ProviderStatus[] } };
  "auth.allProviders": { params: void; result: { providers: ProviderStatus[] } };
  "auth.setApiKey": {
    params: { provider: string; key: string };
    result: { ok: true };
  };
  "auth.deleteApiKey": {
    params: { provider: string };
    result: { ok: true };
  };
  "auth.logout": { params: { provider: string }; result: { ok: true } };
  "auth.loginSubmit": {
    params: { provider: string; token: string; code: string };
    result: { ok: true };
  };
  /** Kick off OAuth login; progress arrives on Streams["auth.login"]. */
  "auth.loginStart": {
    params: { provider: string };
    result: { ok: true; started: boolean };
  };
  "auth.loginCancel": {
    params: { provider: string };
    result: { ok: true };
  };

  "skills.list": {
    params: { cwd?: string } | void;
    result: { skills: SkillRecord[]; diagnostics?: unknown[] };
  };
  "skills.search": {
    params: { query: string };
    result: { results: unknown[] };
  };
  "skills.install": {
    params: { package: string; [key: string]: unknown };
    result: { ok: true; [key: string]: unknown };
  };
  "skills.set": {
    params: SkillUpdateParams;
    result: { ok: true };
  };
  "skills.getContent": {
    params: { cwd: string; filePath: string };
    result: { content: string };
  };

  "plugins.list": {
    params: { cwd?: string } | void;
    result: PluginsResponse;
  };
  "plugins.set": {
    params: PluginActionParams;
    result: PluginsResponse;
  };

  // System / desktop helpers exposed via Host (or main-bridged)
  "system.home": { params: void; result: { home: string } };
  "system.validateCwd": {
    params: { path: string };
    result: { ok: boolean; path?: string; error?: string };
  };
  "system.defaultCwd": { params: void; result: { cwd: string } };
  "system.allowRoot": { params: { path: string }; result: { ok: true } };
  "system.runningCount": { params: void; result: { count: number; sessionIds: string[] } };
}

/** Server-push streams delivered over MessagePort RPC. */
export interface Streams {
  "agent.events": AgentEvent;
  "agent.running": RunningStateEvent;
  "auth.login": LoginProgressEvent;
  "sessions.changed": { cwd: string | null; sessionId?: string };
  "files.changed": {
    path: string;
    event: "connected" | "change" | "error";
    mtime?: string;
    size?: number;
    message?: string;
  };
  "host.restarted": { reason: string };
  "host.ready": { ts: number };
  "channels.status": ChannelStatus;
  "channels.login": ChannelLoginEvent;
  "channels.pairing": ChannelPairingRequest;
  "channels.binding": ChannelBindingChange;
  "channels.activity": ChannelActivity;
}

export type ApiMethod = keyof Api;
export type StreamTopic = keyof Streams;

export type ApiParams<M extends ApiMethod> = Api[M]["params"];
export type ApiResult<M extends ApiMethod> = Api[M]["result"];
