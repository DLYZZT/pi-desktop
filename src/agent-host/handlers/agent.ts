import { existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import type { ApiHandler, RpcServer } from "../../contract/rpc";
import { RpcError } from "../../contract/types";
import { getRpcSession, startRpcSession } from "../rpc-manager";
import { resolveSessionPath } from "../session-reader";
import { readSessionSnapshot } from "../session-readonly";
import { allowFileRoot } from "../file-access";
import { emitIndexedSessionChange } from "../session-change";

export function createAgentNewLockKey(): string {
  return `__new__${randomUUID()}`;
}

type AgentHandlers = {
  new: NonNullable<ApiHandler["agent.new"]>;
  command: NonNullable<ApiHandler["agent.command"]>;
  state: NonNullable<ApiHandler["agent.state"]>;
};
export function createAgentHandlers({
  server,
  bindEvents,
}: {
  server: Pick<RpcServer, "emit">;
  bindEvents: (session: NonNullable<ReturnType<typeof getRpcSession>>, sessionId: string) => void;
}) {
  return {
    new: async (params) => {
      const body = params as {
        cwd: string;
        type?: string;
        message?: string;
        provider?: string;
        modelId?: string;
        toolNames?: string[];
        thinkingLevel?: string;
        [key: string]: unknown;
      };
      const { cwd, provider, modelId, toolNames, thinkingLevel, ...rest } = body;
      if (!cwd || typeof cwd !== "string") {
        throw new RpcError({ code: "BAD_REQUEST", message: "cwd is required" });
      }
      if (!existsSync(cwd)) {
        throw new RpcError({ code: "BAD_REQUEST", message: `Directory does not exist: ${cwd}` });
      }

      const tempKey = createAgentNewLockKey();
      const { session, realSessionId } = await startRpcSession(tempKey, "", cwd, toolNames);
      allowFileRoot(cwd);

      // ISSUE-003: single event-binding entry only (ensureSessionEvents)
      bindEvents(session, realSessionId);

      if (provider && modelId) {
        await session.send({ type: "set_model", provider, modelId });
      }
      if (thinkingLevel) {
        await session.send({ type: "set_thinking_level", level: thinkingLevel });
      }

      if (rest.type === "ensure_session") {
        return { sessionId: realSessionId, data: null };
      }

      const command = rest.type ? rest : { type: "prompt", message: body.message ?? "" };
      const data = await session.send(command as Record<string, unknown>);
      await emitIndexedSessionChange(server, realSessionId, cwd);
      return { sessionId: realSessionId, data };
    },

    command: async (params) => {
      const { sessionId, command } = params as {
        sessionId: string;
        command: Record<string, unknown>;
      };
      const existing = getRpcSession(sessionId);
      if (existing?.isAlive()) {
        // Ensure event subscription
        bindEvents(existing, sessionId);
        return existing.send(command);
      }
      const filePath = await resolveSessionPath(sessionId);
      if (!filePath) throw new RpcError({ code: "NOT_FOUND", message: "Session not found" });
      const cwd = readSessionSnapshot(filePath).getHeader()?.cwd ?? process.cwd();
      const { session } = await startRpcSession(sessionId, filePath, cwd);
      bindEvents(session, sessionId);
      return session.send(command);
    },

    state: async (params) => {
      const { sessionId } = params as { sessionId: string };
      const session = getRpcSession(sessionId);
      if (!session || !session.isAlive()) return { running: false };
      const state = await session.send({ type: "get_state" });
      return { running: true, state };
    },
  } satisfies AgentHandlers;
}
