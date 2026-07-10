import type {
  AgentCommand,
  AgentEvent,
  ContextInfo,
  DirEntry,
  FileContent,
  FileMeta,
  FuzzyMatch,
  LoginProgressEvent,
  ModelInfo,
  ModelsConfig,
  ModelsListResult,
  ProviderStatus,
  RunningStateEvent,
  SessionDetail,
  SessionInfo,
  SkillInfo,
  TestResult,
  WorktreeInfo,
} from "./types";

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
  "sessions.delete": { params: { id: string }; result: { ok: true } };
  "sessions.rename": {
    params: { id: string; name: string };
    result: { ok: true };
  };

  "worktrees.list": {
    params: { projectRoot: string };
    result: { worktrees: WorktreeInfo[] };
  };
  "worktrees.create": {
    params: { projectRoot: string; branch?: string; path?: string; [key: string]: unknown };
    result: { worktree: WorktreeInfo };
  };
  "worktrees.remove": {
    params: { path: string; [key: string]: unknown };
    result: { ok: true };
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

  // Files
  "files.list": { params: { path: string }; result: { entries: DirEntry[] } };
  "files.read": {
    params: { path: string; sourceSessionId?: string };
    result: FileContent;
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
    result: { matches: FuzzyMatch[] };
  };

  // Config
  "models.list": {
    params: { cwd?: string } | void;
    result: ModelsListResult;
  };
  "modelsConfig.get": { params: void; result: ModelsConfig };
  "modelsConfig.set": { params: ModelsConfig; result: { ok: true } };
  "modelsConfig.test": {
    params: { provider: string; [key: string]: unknown };
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

  "skills.list": {
    params: { cwd?: string } | void;
    result: { skills: SkillInfo[] };
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
    params: unknown;
    result: { ok: true };
  };

  "plugins.list": {
    params: { cwd?: string } | void;
    result: unknown;
  };
  "plugins.set": {
    params: unknown;
    result: { ok: true };
  };

  // System / desktop helpers exposed via Host (or main-bridged)
  "system.home": { params: void; result: { home: string } };
  "system.validateCwd": {
    params: { path: string };
    result: { ok: boolean; path?: string; error?: string };
  };
  "system.defaultCwd": { params: void; result: { cwd: string } };
}

/** Server-push streams (replaces SSE routes). */
export interface Streams {
  "agent.events": AgentEvent;
  "agent.running": RunningStateEvent;
  "auth.login": LoginProgressEvent;
  "sessions.changed": { cwd: string | null };
  "files.changed": { path: string; event: string };
  "host.restarted": { reason: string };
  "host.ready": { ts: number };
}

export type ApiMethod = keyof Api;
export type StreamTopic = keyof Streams;

export type ApiParams<M extends ApiMethod> = Api[M]["params"];
export type ApiResult<M extends ApiMethod> = Api[M]["result"];
