import { existsSync, readFileSync, renameSync } from "node:fs";
import type { ChannelActivity, ChannelPairingRequest, DeliveryReceipt } from "../../shared/channel-types";
import { atomicWrite } from "./config-store";

type ChannelStateFile = {
  version: 1;
  cursors: Record<string, string>;
  contextTokens: Record<string, string>;
  processed: Record<string, number>;
  pairings: ChannelPairingRequest[];
  deliveries: DeliveryReceipt[];
  activities: ChannelActivity[];
};

const MAX_PROCESSED = 5_000;
const MAX_DELIVERIES = 500;
const MAX_ACTIVITIES = 100;
const PROCESSED_TTL_MS = 7 * 24 * 60 * 60 * 1000;

function emptyState(): ChannelStateFile {
  return {
    version: 1,
    cursors: {},
    contextTokens: {},
    processed: {},
    pairings: [],
    deliveries: [],
    activities: [],
  };
}

export class ChannelStateStore {
  private data: ChannelStateFile;
  private readonly filePath: string;

  constructor(filePath: string) {
    this.filePath = filePath;
    this.data = this.read();
    this.prune(false);
  }

  private read(): ChannelStateFile {
    if (!existsSync(this.filePath)) return emptyState();
    try {
      const parsed = JSON.parse(readFileSync(this.filePath, "utf8")) as Partial<ChannelStateFile>;
      if (parsed.version !== undefined && parsed.version !== 1) {
        throw new Error(`Unsupported channels state version: ${String(parsed.version)}`);
      }
      const migrated: ChannelStateFile = {
        version: 1,
        cursors: parsed.cursors && typeof parsed.cursors === "object" ? parsed.cursors : {},
        contextTokens: parsed.contextTokens && typeof parsed.contextTokens === "object" ? parsed.contextTokens : {},
        processed: parsed.processed && typeof parsed.processed === "object" ? parsed.processed : {},
        pairings: Array.isArray(parsed.pairings) ? parsed.pairings : [],
        deliveries: Array.isArray(parsed.deliveries) ? parsed.deliveries : [],
        activities: Array.isArray(parsed.activities) ? parsed.activities : [],
      };
      if (parsed.version === undefined) atomicWrite(this.filePath, migrated);
      return migrated;
    } catch (error) {
      if (error instanceof SyntaxError) {
        renameSync(this.filePath, `${this.filePath}.corrupt-${Date.now()}`);
        return emptyState();
      }
      throw error;
    }
  }

  private persist(): void {
    atomicWrite(this.filePath, this.data);
  }

  private prune(persist = true): void {
    const cutoff = Date.now() - PROCESSED_TTL_MS;
    const processed = Object.entries(this.data.processed)
      .filter(([, timestamp]) => timestamp >= cutoff)
      .sort((a, b) => b[1] - a[1])
      .slice(0, MAX_PROCESSED);
    this.data.processed = Object.fromEntries(processed);
    const now = Date.now();
    this.data.pairings = this.data.pairings.filter((item) => Date.parse(item.expiresAt) > now);
    this.data.deliveries = this.data.deliveries.slice(-MAX_DELIVERIES);
    this.data.activities = this.data.activities.slice(-MAX_ACTIVITIES);
    if (persist) this.persist();
  }

  private accountPeerKey(accountId: string, peerId: string): string {
    return `${accountId}\u0000${peerId}`;
  }

  getCursor(accountId: string): string {
    return this.data.cursors[accountId] ?? "";
  }

  setCursor(accountId: string, cursor: string): void {
    this.data.cursors[accountId] = cursor;
    this.persist();
  }

  getContextToken(accountId: string, peerId: string): string | undefined {
    return this.data.contextTokens[this.accountPeerKey(accountId, peerId)];
  }

  setContextToken(accountId: string, peerId: string, token: string): void {
    this.data.contextTokens[this.accountPeerKey(accountId, peerId)] = token;
    this.persist();
  }

  isProcessed(accountId: string, eventId: string): boolean {
    return this.data.processed[`${accountId}\u0000${eventId}`] !== undefined;
  }

  markProcessed(accountId: string, eventId: string): void {
    this.data.processed[`${accountId}\u0000${eventId}`] = Date.now();
    this.prune();
  }

  listPairings(): ChannelPairingRequest[] {
    this.prune(false);
    return structuredClone(this.data.pairings);
  }

  findPairing(accountId: string, peerId: string): ChannelPairingRequest | undefined {
    this.prune(false);
    const found = this.data.pairings.find((item) => item.accountId === accountId && item.peerId === peerId);
    return found ? structuredClone(found) : undefined;
  }

  upsertPairing(pairing: ChannelPairingRequest): void {
    this.data.pairings = this.data.pairings.filter(
      (item) => item.id !== pairing.id && !(item.accountId === pairing.accountId && item.peerId === pairing.peerId),
    );
    this.data.pairings.push(structuredClone(pairing));
    this.prune();
  }

  removePairing(pairingId: string): ChannelPairingRequest | undefined {
    const found = this.data.pairings.find((item) => item.id === pairingId);
    this.data.pairings = this.data.pairings.filter((item) => item.id !== pairingId);
    this.persist();
    return found ? structuredClone(found) : undefined;
  }

  addDelivery(receipt: DeliveryReceipt): void {
    this.data.deliveries.push(structuredClone(receipt));
    this.prune();
  }

  addActivity(activity: ChannelActivity): void {
    this.data.activities.push(structuredClone(activity));
    this.prune();
  }

  listActivities(): ChannelActivity[] {
    return structuredClone(this.data.activities.slice().reverse());
  }

  deleteAccount(accountId: string): void {
    delete this.data.cursors[accountId];
    this.data.contextTokens = Object.fromEntries(
      Object.entries(this.data.contextTokens).filter(([key]) => !key.startsWith(`${accountId}\u0000`)),
    );
    this.data.processed = Object.fromEntries(
      Object.entries(this.data.processed).filter(([key]) => !key.startsWith(`${accountId}\u0000`)),
    );
    this.data.pairings = this.data.pairings.filter((item) => item.accountId !== accountId);
    this.data.deliveries = this.data.deliveries.filter((item) => item.accountId !== accountId);
    this.data.activities = this.data.activities.filter((item) => item.accountId !== accountId);
    this.persist();
  }
}
