import type { ExtensionAPI, SessionManager } from "@earendil-works/pi-coding-agent";
import { getAgentSessionSource } from "./session-source.ts";
import { redactHerdrPersistedMessage } from "./herdr/session-redaction.ts";
import { redactManagedProcessPersistedMessage } from "./managed-process/session-redaction.ts";

type ProjectedMessage = ReturnType<SessionManager["buildSessionProjection"]>["messages"][number];

type SensitiveRecord = {
  entryId: string;
  original: ProjectedMessage;
  persisted: ProjectedMessage;
  scope: string;
  bytes: number;
};

const MAX_SESSION_BYTES = 16 * 1024 * 1024;
const MAX_HOST_BYTES = 64 * 1024 * 1024;

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function isSensitiveMessage(message: unknown): boolean {
  return redactManagedProcessPersistedMessage(message) !== message || redactHerdrPersistedMessage(message) !== message;
}

/**
 * Keeps the live-only part of sensitive tool messages in memory. The existing
 * SessionManager wrappers continue to write redacted copies to JSONL.
 */
export class SessionEphemeralContext {
  private static hostBytes = 0;
  private readonly records = new Map<string, SensitiveRecord>();
  private sessionBytes = 0;
  private scope = "local";
  private generation = 0;
  private lastSensitiveRequest: { scope: string; generation: number } | undefined;
  private installed = false;
  private active = true;
  private captureAllowed = true;
  private readonly manager: SessionManager;

  constructor(manager: SessionManager) {
    this.manager = manager;
  }

  install(): void {
    if (this.installed) return;
    const appendMessage = this.manager.appendMessage.bind(this.manager);
    this.manager.appendMessage = (message) => {
      if (!this.active || !this.captureAllowed || !isSensitiveMessage(message)) return appendMessage(message);
      const original = structuredClone(message) as ProjectedMessage;
      const bytes = Buffer.byteLength(JSON.stringify(original), "utf8");
      if (this.sessionBytes + bytes > MAX_SESSION_BYTES || SessionEphemeralContext.hostBytes + bytes > MAX_HOST_BYTES) {
        throw new Error("Sensitive tool output exceeds the live context memory budget; request a smaller result");
      }
      const entryId = appendMessage(message);
      const persisted = this.manager.getEntry(entryId);
      if (!persisted || persisted.type !== "message") {
        throw new Error("Sensitive tool message was not saved as a session message");
      }
      this.records.set(entryId, {
        entryId,
        original,
        persisted: structuredClone(persisted.message) as ProjectedMessage,
        scope: this.scope,
        bytes,
      });
      this.sessionBytes += bytes;
      SessionEphemeralContext.hostBytes += bytes;
      return entryId;
    };
    this.installed = true;
  }

  beginChannelTurn(runId: string): void {
    if (!this.active) return;
    this.scope = "channel:" + runId;
    this.captureAllowed = true;
  }

  beginLocalTurn(): void {
    if (!this.active) return;
    this.scope = "local";
    this.captureAllowed = true;
  }

  suspendAfterAbort(): void {
    if (!this.active) return;
    this.captureAllowed = false;
    this.clear();
  }

  endChannelTurn(): void {
    if (!this.active) return;
    this.generation++;
    for (const [entryId, record] of this.records) {
      if (record.scope.startsWith("channel:")) this.remove(entryId);
    }
    this.scope = "local";
  }

  clear(): void {
    this.generation++;
    for (const entryId of this.records.keys()) this.remove(entryId);
  }

  dispose(): void {
    this.active = false;
    this.clear();
  }

  shouldStopCacheWarming(): boolean {
    if (!this.active || !this.captureAllowed) return true;
    const request = this.lastSensitiveRequest;
    if (!request) return false;
    if (request.scope !== this.scope || request.generation !== this.generation) return true;
    const source = getAgentSessionSource(this.manager);
    return this.scope === "local" ? source !== "local" : source !== "channel";
  }

  private remove(entryId: string): void {
    const record = this.records.get(entryId);
    if (!record) return;
    this.records.delete(entryId);
    this.sessionBytes -= record.bytes;
    SessionEphemeralContext.hostBytes -= record.bytes;
  }

  /** Runs after the SDK has selected the canonical branch and applied context edits. */
  transform(messages: ProjectedMessage[]): ProjectedMessage[] {
    if (!this.active) return messages;
    const source = getAgentSessionSource(this.manager);
    if ((this.scope === "local" && source !== "local") || (this.scope !== "local" && source !== "channel")) {
      return messages;
    }
    const projection = this.manager.buildSessionProjection();
    const editedIds = new Set(
      projection.entries.flatMap(({ sourceEntry }) =>
        sourceEntry.type === "context_edit" ? [sourceEntry.targetId] : [],
      ),
    );
    const selectedIds = new Set(
      projection.entries.flatMap(({ sourceEntry, messages: projected }) =>
        sourceEntry.type === "message" && projected.length > 0 && !editedIds.has(sourceEntry.id)
          ? [sourceEntry.id]
          : [],
      ),
    );
    for (const entryId of this.records.keys()) {
      if (!selectedIds.has(entryId)) this.remove(entryId);
    }
    const eligible = [...this.records.values()].filter((record) => record.scope === this.scope);
    if (eligible.length === 0) {
      this.lastSensitiveRequest = undefined;
      return messages;
    }

    let restored = false;
    const transformed = messages.map((message) => {
      if (message.role === "toolResult") {
        const matches = eligible.filter(
          (record) =>
            record.persisted.role === "toolResult" &&
            record.persisted.toolCallId === message.toolCallId &&
            record.persisted.toolName === message.toolName &&
            sameJson(record.persisted.content, message.content),
        );
        if (matches.length > 1) throw new Error("Ambiguous sensitive tool result identity in model context");
        const original = matches[0]?.original;
        if (original?.role !== "toolResult") return message;
        restored = true;
        return {
          ...message,
          content: structuredClone(original.content),
          details: structuredClone(original.details),
        };
      }
      if (message.role !== "assistant" || !Array.isArray(message.content)) return message;
      let changed = false;
      const content = message.content.map((block) => {
        if (block.type !== "toolCall") return block;
        const matches = eligible.flatMap((record) => {
          if (record.persisted.role !== "assistant" || record.original.role !== "assistant") return [];
          const saved = record.persisted.content.find(
            (candidate) => candidate.type === "toolCall" && candidate.id === block.id && candidate.name === block.name,
          );
          const raw = record.original.content.find(
            (candidate) => candidate.type === "toolCall" && candidate.id === block.id && candidate.name === block.name,
          );
          return saved?.type === "toolCall" && raw?.type === "toolCall" && sameJson(saved.arguments, block.arguments)
            ? [raw]
            : [];
        });
        if (matches.length > 1) throw new Error("Ambiguous sensitive tool call identity in model context");
        if (!matches[0]) return block;
        changed = true;
        restored = true;
        return { ...block, arguments: structuredClone(matches[0].arguments) };
      });
      return changed ? { ...message, content } : message;
    });
    this.lastSensitiveRequest = restored ? { scope: this.scope, generation: this.generation } : undefined;
    return transformed;
  }
}

export function createEphemeralContextExtension(context: SessionEphemeralContext) {
  return {
    name: "pi-desktop-ephemeral-context",
    hidden: true,
    factory(pi: ExtensionAPI) {
      pi.on("context", (event) => ({ messages: context.transform(event.messages) }));
      pi.on("cache_warming_decision", (event) =>
        event.action === "warm" && context.shouldStopCacheWarming() ? { action: "stop" } : undefined,
      );
    },
  };
}
