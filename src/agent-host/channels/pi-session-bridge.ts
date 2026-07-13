import { mkdirSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import type { ChannelBinding, InboundEnvelope } from "../../shared/channel-types";
import { allowFileRoot, invalidateAllowedRootsCache } from "../file-access";
import { getRpcSession, startRpcSession, type AgentSessionWrapper } from "../rpc-manager";
import { resolveSessionPath } from "../session-reader";

export interface ExternalTurnResult {
  sessionId: string;
  finalText: string;
  generatedFiles: string[];
}

export class PiSessionBridge {
  private readonly onSession: (session: AgentSessionWrapper, sessionId: string) => void;

  constructor(onSession: (session: AgentSessionWrapper, sessionId: string) => void) {
    this.onSession = onSession;
  }

  private async open(binding: ChannelBinding): Promise<{ session: AgentSessionWrapper; sessionId: string }> {
    mkdirSync(binding.cwd, { recursive: true });
    allowFileRoot(binding.cwd);
    invalidateAllowedRootsCache();

    if (binding.sessionId) {
      const existing = getRpcSession(binding.sessionId);
      if (existing?.isAlive()) {
        this.onSession(existing, binding.sessionId);
        return { session: existing, sessionId: binding.sessionId };
      }
      const sessionFile = await resolveSessionPath(binding.sessionId);
      if (sessionFile) {
        const cwd = SessionManager.open(sessionFile).getHeader()?.cwd ?? binding.cwd;
        const started = await startRpcSession(binding.sessionId, sessionFile, cwd);
        this.onSession(started.session, started.realSessionId);
        return { session: started.session, sessionId: started.realSessionId };
      }
    }

    const started = await startRpcSession(`__channel__${randomUUID()}`, "", binding.cwd, binding.toolNames);
    this.onSession(started.session, started.realSessionId);
    return { session: started.session, sessionId: started.realSessionId };
  }

  async runTurn(binding: ChannelBinding, envelope: InboundEnvelope): Promise<ExternalTurnResult> {
    const { session, sessionId } = await this.open(binding);
    const runId = randomUUID();
    const source = envelope.channel === "weixin" ? "微信" : envelope.channel;
    const message = [
      `[外部消息来源：${source}]`,
      `发送者标识：${envelope.sender.id}`,
      envelope.peer.kind === "group" ? `群聊标识：${envelope.peer.id}` : "会话类型：私聊",
      "---",
      envelope.text,
    ].join("\n");
    const result = await session.runExternalTurn({ runId, message });
    return { sessionId, finalText: result.finalText, generatedFiles: [] };
  }
}
