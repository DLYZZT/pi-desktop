import { randomUUID } from "node:crypto";
import { SessionManager, getAgentDir } from "@earendil-works/pi-coding-agent";
import { createDesktopAgentSessionServices as createAgentSessionServices } from "../desktop-session-services";
import type { ApiHandler, RpcServer } from "../../contract/rpc";
import { RpcError } from "../../contract/types";
import {
  AUTO_TITLE_MAX_LENGTH,
  makeFallbackTitle,
  messageContentText,
  sanitizeGeneratedTitle,
  takeCodePoints,
} from "../session-title";
import { getRpcSession } from "../rpc-manager";
import { resolveSessionPath } from "../session-reader";
import { readSessionSnapshot, assertSessionWritable } from "../session-readonly";
import { invalidateSessionContent } from "../session-content-cache";
import { validateExistingDirectory } from "../directory-validation";
import { emitIndexedSessionChange } from "../session-change";
import type { AvailableModel } from "./model-catalog";

const AUTO_TITLE_REQUEST_MAX_CHARS = 2000;

const AUTO_TITLE_MAX_TOKENS = 60;

const AUTO_TITLE_TIMEOUT_MS = 15_000;

const AUTO_TITLE_SYSTEM_PROMPT =
  "You create a concise session title from the user's first message. " +
  "Rules: match the language of the message; return only a short noun phrase " +
  `of at most ${AUTO_TITLE_MAX_LENGTH} characters; no quotes, no trailing punctuation, no Markdown.`;

type TitleSessionServices = Awaited<ReturnType<typeof createAgentSessionServices>>;

type TitleModelServices = Pick<TitleSessionServices, "modelRuntime" | "settingsManager"> &
  Partial<Pick<TitleSessionServices, "azureUpgrade">>;

function resolveTitleModel(
  services: TitleModelServices,
  provider?: string,
  modelId?: string,
): AvailableModel | undefined {
  const runtime = services.modelRuntime;
  const settings = services.settingsManager;
  const defaultProvider = settings.getDefaultProvider();
  const defaultModelId = settings.getDefaultModel();
  const targetProvider = provider ?? defaultProvider;
  if (services.azureUpgrade?.status === "review" && ["azure", "azure-openai-responses"].includes(targetProvider ?? ""))
    return;
  if (provider || modelId)
    return provider && modelId ? (runtime.getModel(provider, modelId) as AvailableModel | undefined) : undefined;
  if (defaultProvider || defaultModelId)
    return defaultProvider && defaultModelId
      ? (runtime.getModel(defaultProvider, defaultModelId) as AvailableModel | undefined)
      : undefined;
  return runtime.getAvailableSnapshot()[0];
}

async function generateSessionTitle(
  services: TitleModelServices,
  message: string,
  provider?: string,
  modelId?: string,
): Promise<string | null> {
  const model = resolveTitleModel(services, provider, modelId);
  if (!model) return null;
  try {
    const assistant = await services.modelRuntime.completeSimple(
      model,
      {
        systemPrompt: AUTO_TITLE_SYSTEM_PROMPT,
        messages: [
          {
            role: "user",
            content: takeCodePoints(message, AUTO_TITLE_REQUEST_MAX_CHARS),
            timestamp: Date.now(),
          },
        ],
      },
      {
        // Standalone request: never reuse or write prompt-cache entries.
        cacheRetention: "none",
        maxTokens: AUTO_TITLE_MAX_TOKENS,
        sessionId: randomUUID(),
        signal: AbortSignal.timeout(AUTO_TITLE_TIMEOUT_MS),
      },
    );
    return sanitizeGeneratedTitle(messageContentText(assistant.content));
  } catch {
    return null;
  }
}

export async function generateSessionTitleWithFallback(
  createServices: () => Promise<TitleModelServices>,
  message: string,
  provider?: string,
  modelId?: string,
): Promise<string> {
  try {
    const services = await createServices();
    const generated = await generateSessionTitle(services, message, provider, modelId);
    return generated ?? makeFallbackTitle(message);
  } catch {
    // Service creation can fail before a model request starts (for example,
    // while loading project resources). The local fallback must still apply.
    return makeFallbackTitle(message);
  }
}

async function hasSessionName(sessionId: string): Promise<boolean> {
  const existing = getRpcSession(sessionId);
  if (existing?.isAlive()) {
    const name = existing.inner.sessionName;
    return typeof name === "string" && name.trim().length > 0;
  }
  try {
    const filePath = await resolveSessionPath(sessionId);
    if (!filePath) return false;
    const storedName = readSessionSnapshot(filePath).getSessionName();
    return typeof storedName === "string" && storedName.trim().length > 0;
  } catch {
    return false;
  }
}

function applyLiveSessionNameIfEmpty(sessionId: string, name: string): boolean | null {
  const existing = getRpcSession(sessionId);
  if (!existing?.isAlive()) return null;
  const currentName = existing.inner.sessionName;
  if (typeof currentName === "string" && currentName.trim().length > 0) return false;

  // Keep the check and write in the same synchronous turn. A manual rename
  // that ran first is observed above; one that runs later overwrites this
  // automatic value, so the manual choice always wins.
  existing.inner.setSessionName(name);
  return true;
}

export async function applySessionNameIfEmpty(sessionId: string, name: string): Promise<boolean> {
  const normalized = name.trim();
  if (!normalized) return false;

  const liveResult = applyLiveSessionNameIfEmpty(sessionId, normalized);
  if (liveResult !== null) return liveResult;

  const filePath = await resolveSessionPath(sessionId);
  if (!filePath) return false;

  // The session may have become live while its path was resolving.
  const liveResultAfterLookup = applyLiveSessionNameIfEmpty(sessionId, normalized);
  if (liveResultAfterLookup !== null) return liveResultAfterLookup;

  assertSessionWritable(filePath);
  const manager = SessionManager.open(filePath, undefined);
  const storedName = manager.getSessionName();
  if (typeof storedName === "string" && storedName.trim().length > 0) return false;

  // SessionManager's read and append are synchronous, so another Renderer RPC
  // cannot interleave a manual rename between this final check and the write.
  manager.appendSessionInfo(normalized);
  invalidateSessionContent(filePath);
  return true;
}

async function resolveTitleSessionTarget(
  sessionId: string,
): Promise<{ cwd: string; services?: TitleModelServices } | null> {
  const existing = getRpcSession(sessionId);
  if (existing?.isAlive()) {
    if (existing.modelSelection.snapshot(existing.inner)?.requiresChoice) return null;
    const dir = validateExistingDirectory(existing.cwd);
    if (!dir.ok) return null;
    return {
      cwd: dir.path,
      services: {
        modelRuntime: existing.inner.modelRuntime as unknown as TitleSessionServices["modelRuntime"],
        settingsManager: existing.inner.settingsManager,
      },
    };
  }

  const filePath = await resolveSessionPath(sessionId);
  if (!filePath) return null;
  const cwd = readSessionSnapshot(filePath).getHeader()?.cwd;
  const dir = validateExistingDirectory(cwd);
  return dir.ok ? { cwd: dir.path } : null;
}

type TitleHandlers = {
  generate: NonNullable<ApiHandler["agent.generateTitle"]>;
};
export function createTitleHandlers(server: Pick<RpcServer, "emit">) {
  return {
    generate: async (params) => {
      const body = params as {
        sessionId: string;
        message: string;
        provider?: string;
        modelId?: string;
      };
      const { sessionId, message } = body;
      if (typeof sessionId !== "string" || !sessionId) {
        throw new RpcError({ code: "BAD_REQUEST", message: "sessionId is required" });
      }
      if (typeof message !== "string" || !message.trim()) {
        throw new RpcError({ code: "BAD_REQUEST", message: "message is required" });
      }
      const target = await resolveTitleSessionTarget(sessionId);
      if (!target) return { title: null };

      // Never overwrite a title the user already set (or an earlier title).
      if (await hasSessionName(sessionId)) return { title: null };

      const finalTitle = await generateSessionTitleWithFallback(
        target.services
          ? async () => target.services as TitleModelServices
          : () => createAgentSessionServices({ cwd: target.cwd, agentDir: getAgentDir() }),
        message,
        body.provider,
        body.modelId,
      );

      // Check and write atomically at the live session or SessionManager edge.
      // A concurrent manual rename either runs first and blocks this write, or
      // runs afterwards and replaces the automatic title.
      if (!(await applySessionNameIfEmpty(sessionId, finalTitle))) return { title: null };

      await emitIndexedSessionChange(server, sessionId, target.cwd);
      return { title: finalTitle };
    },
  } satisfies TitleHandlers;
}
