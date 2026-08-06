import { createHash, randomUUID } from "node:crypto";
import type { BrowserConfirmationKind, BrowserConfirmationProof } from "../../contract/browser.ts";
import { BrowserError } from "./browser-error.ts";

const DEFAULT_CONFIRMATION_TTL_MS = 2 * 60 * 1_000;

type PendingConfirmation = BrowserConfirmationProof & { consumed: boolean };

export class BrowserConfirmationManager {
  private readonly pending = new Map<string, PendingConfirmation>();
  private readonly options: {
    now?: () => number;
    createId?: () => string;
    ttlMs?: number;
  };

  constructor(options: { now?: () => number; createId?: () => string; ttlMs?: number } = {}) {
    this.options = options;
  }

  issue(kind: BrowserConfirmationKind, payload: unknown): BrowserConfirmationProof {
    this.prune();
    const proof: PendingConfirmation = {
      id: this.options.createId?.() ?? randomUUID(),
      kind,
      expiresAt: (this.options.now?.() ?? Date.now()) + (this.options.ttlMs ?? DEFAULT_CONFIRMATION_TTL_MS),
      digest: browserConfirmationDigest(kind, payload),
      consumed: false,
    };
    this.pending.set(proof.id, proof);
    return publicProof(proof);
  }

  consume(proof: BrowserConfirmationProof | undefined, kind: BrowserConfirmationKind, payload: unknown): void {
    this.prune();
    if (!proof) throw confirmationError(kind);
    const pending = this.pending.get(proof.id);
    const now = this.options.now?.() ?? Date.now();
    if (
      !pending ||
      pending.consumed ||
      pending.kind !== kind ||
      pending.expiresAt <= now ||
      proof.kind !== kind ||
      proof.expiresAt !== pending.expiresAt ||
      proof.digest !== pending.digest ||
      pending.digest !== browserConfirmationDigest(kind, payload)
    ) {
      throw confirmationError(kind);
    }
    pending.consumed = true;
    this.pending.delete(pending.id);
  }

  clear(): void {
    this.pending.clear();
  }

  private prune(): void {
    const now = this.options.now?.() ?? Date.now();
    for (const [id, proof] of this.pending) {
      if (proof.consumed || proof.expiresAt <= now) this.pending.delete(id);
    }
  }
}

export function browserConfirmationDigest(kind: BrowserConfirmationKind, payload: unknown): string {
  return createHash("sha256").update(kind).update("\0").update(stableJson(payload)).digest("hex");
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "undefined";
  if (Array.isArray(value)) return `[${value.map((entry) => stableJson(entry)).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
    .join(",")}}`;
}

function publicProof(proof: PendingConfirmation): BrowserConfirmationProof {
  return { id: proof.id, kind: proof.kind, expiresAt: proof.expiresAt, digest: proof.digest };
}

function confirmationError(kind: BrowserConfirmationKind): BrowserError {
  if (kind === "request-replay") {
    return new BrowserError(
      "REQUEST_REPLAY_CONFIRMATION_REQUIRED",
      "A fresh local confirmation is required for request replay",
    );
  }
  return new BrowserError(
    kind === "advanced-browser-mode" ? "ADVANCED_BROWSER_MODE_REQUIRED" : "ADVANCED_CONFIRMATION_REQUIRED",
    `A fresh local confirmation is required for ${kind}`,
  );
}
