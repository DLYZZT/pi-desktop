import type {
  ChannelAccountConfig,
  ChannelId,
  ChannelLoginEvent,
  ChannelProbeResult,
  ChannelStatus,
  DeliveryReceipt,
  InboundEnvelope,
} from "../../shared/channel-types";
import type { ChannelStateStore } from "./state-store";

export interface ChannelSecret {
  token: string;
  providerAccountId: string;
  baseUrl: string;
}

export interface AdapterStartContext {
  account: ChannelAccountConfig;
  secret: ChannelSecret;
  signal: AbortSignal;
  state: ChannelStateStore;
  onInbound: (envelope: InboundEnvelope) => Promise<void>;
  onStatus: (patch: Partial<ChannelStatus>) => void;
  log: (message: string) => void;
}

export interface AdapterSendContext {
  account: ChannelAccountConfig;
  secret: ChannelSecret;
  peerId: string;
  text: string;
  contextToken?: string;
  runId?: string;
}

export interface AdapterTypingContext {
  account: ChannelAccountConfig;
  secret: ChannelSecret;
  peerId: string;
  contextToken?: string;
  typing: boolean;
}

export interface AdapterLoginPollResult {
  event: ChannelLoginEvent;
  credential?: ChannelSecret & { userId?: string };
}

export interface ChannelAdapter {
  id: ChannelId;
  start(context: AdapterStartContext): Promise<void>;
  send(context: AdapterSendContext): Promise<DeliveryReceipt>;
  setTyping?(context: AdapterTypingContext): Promise<void>;
  probe(account: ChannelAccountConfig, secret: ChannelSecret): Promise<ChannelProbeResult>;
  startLogin(force?: boolean, localTokens?: string[]): Promise<ChannelLoginEvent>;
  pollLogin(sessionKey: string): Promise<AdapterLoginPollResult>;
  submitLoginCode(sessionKey: string, code: string): void;
  cancelLogin(sessionKey: string): void;
}
