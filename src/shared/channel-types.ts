export type ChannelId = "weixin" | "telegram";

export type ChannelDmPolicy = "pairing" | "allowlist" | "open";
export type ChannelGroupPolicy = "disabled" | "allowlist" | "open";
export type ChannelRuntimeState = "starting" | "running" | "reconnecting" | "stopped" | "error";

export interface ChannelAccountConfig {
  id: string;
  channel: ChannelId;
  name: string;
  enabled: boolean;
  providerAccountId?: string;
  providerUsername?: string;
  userId?: string;
  baseUrl?: string;
  dmPolicy: ChannelDmPolicy;
  allowFrom: string[];
  groupPolicy: ChannelGroupPolicy;
  groupIds: string[];
  groupAllowFrom: string[];
  requireMention: boolean;
  /** Opt-in slash commands handled by Pi Desktop before normal Agent routing. */
  commandsEnabled?: boolean;
  defaultCwd?: string;
  toolNames: string[];
  createdAt: string;
  updatedAt: string;
}

export interface ChannelAccountView extends ChannelAccountConfig {
  configured: boolean;
  credentialFingerprint?: string;
}

export interface ChannelStatus {
  channel: ChannelId;
  accountId: string;
  state: ChannelRuntimeState;
  connected: boolean;
  lastStartAt?: number;
  lastConnectedAt?: number;
  lastEventAt?: number;
  lastInboundAt?: number;
  lastOutboundAt?: number;
  lastError?: string;
  retryCount?: number;
}

export interface ChannelPairingRequest {
  id: string;
  code: string;
  channel: ChannelId;
  accountId: string;
  peerId: string;
  displayName?: string;
  createdAt: string;
  expiresAt: string;
}

export interface ChannelBinding {
  id: string;
  channel: ChannelId;
  accountId: string;
  peerKind: "dm" | "group";
  peerId: string;
  threadId?: string;
  sessionId?: string;
  cwd: string;
  toolNames: string[];
  createdAt: string;
  lastUsedAt: string;
}

export interface ChannelBindingChange {
  action: "upsert" | "delete";
  bindingId: string;
  binding?: ChannelBinding;
}

export interface ChannelActivity {
  id: string;
  channel: ChannelId;
  accountId: string;
  direction: "inbound" | "outbound" | "system";
  outcome: "accepted" | "ignored" | "sent" | "failed";
  peerId?: string;
  at: string;
  detail?: string;
}

export interface ChannelsSnapshot {
  accounts: ChannelAccountView[];
  statuses: ChannelStatus[];
  pairings: ChannelPairingRequest[];
  bindings: ChannelBinding[];
  activities: ChannelActivity[];
}

export type ChannelLoginPhase =
  | "qr"
  | "waiting"
  | "scanned"
  | "verification_required"
  | "confirmed"
  | "already_connected"
  | "expired"
  | "error"
  | "cancelled";

export interface ChannelLoginEvent {
  channel: ChannelId;
  sessionKey: string;
  phase: ChannelLoginPhase;
  message: string;
  qrDataUrl?: string;
  qrContent?: string;
  accountId?: string;
}

export interface ChannelProbeResult {
  ok: boolean;
  message: string;
  accountId: string;
  providerAccountId?: string;
  providerUsername?: string;
  displayName?: string;
}

export interface ChannelTestSendResult {
  ok: true;
  messageId: string;
}

export interface InboundAttachment {
  kind: "image" | "voice" | "file" | "video";
  name?: string;
  mime?: string;
}

export interface InboundEnvelope {
  id: string;
  channel: ChannelId;
  accountId: string;
  peer: { kind: "dm" | "group"; id: string };
  threadId?: string;
  sender: { id: string; name?: string; username?: string };
  text: string;
  mentionsBot: boolean;
  replyTo?: { messageId: string; text?: string; senderId?: string };
  attachments: InboundAttachment[];
  timestamp: number;
  providerContext?: {
    contextToken?: string;
    replyToMessageId?: string;
  };
}

export interface DeliveryReceipt {
  id: string;
  channel: ChannelId;
  accountId: string;
  peerId: string;
  messageId: string;
  deliveredAt: string;
}
