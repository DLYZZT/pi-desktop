import type {
  ChannelAccountConfig,
  ChannelId,
  ChannelLoginEvent,
  ChannelProbeResult,
  ChannelStatus,
  DeliveryReceipt,
  InboundEnvelope,
} from "../../shared/channel-types";
import type { AgentMessage } from "../../shared/types";
import type { ChannelStateStore } from "./state-store";

export interface ChannelSecret {
  token: string;
  providerAccountId: string;
  providerUsername?: string;
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
  threadId?: string;
  replyToMessageId?: string;
  runId?: string;
  /** Optional, explicitly authorized local files. Existing text-only adapters can ignore this capability. */
  attachments?: OutboundAttachment[];
}

export interface OutboundAttachment {
  kind: "image" | "voice" | "file" | "video";
  path: string;
  name?: string;
  mime?: string;
}

export interface DownloadedInboundAttachment {
  kind: "image" | "voice" | "file" | "video";
  data: Buffer;
  name?: string;
  mime?: string;
}

export interface StagedInboundAttachment extends Omit<DownloadedInboundAttachment, "data"> {
  path: string;
  size: number;
}

export interface AdapterDownloadInboundContext {
  account: ChannelAccountConfig;
  secret: ChannelSecret;
  envelope: InboundEnvelope;
}

export interface AdapterTypingContext {
  account: ChannelAccountConfig;
  secret: ChannelSecret;
  peerId: string;
  contextToken?: string;
  threadId?: string;
  typing: boolean;
}

export type ChannelTurnProgressEvent =
  | { type: "message"; phase: "start" | "update" | "end"; message: AgentMessage }
  | { type: "tool_start"; toolCallId: string; toolName: string; args: unknown }
  | { type: "tool_update"; toolCallId: string; toolName: string; args: unknown; partialResult: unknown }
  | { type: "tool_end"; toolCallId: string; toolName: string; result: unknown; isError: boolean };

export interface AdapterTurnContext extends Omit<AdapterSendContext, "text"> {
  peerKind: "dm" | "group";
}

export interface AdapterTurnOutput {
  update(event: ChannelTurnProgressEvent): void;
  finish(text: string): Promise<DeliveryReceipt>;
  cancel(): Promise<void>;
}

export interface AdapterLoginPollResult {
  event: ChannelLoginEvent;
  credential?: ChannelSecret & { userId?: string };
}

export interface ChannelAdapter {
  id: ChannelId;
  start(context: AdapterStartContext): Promise<void>;
  send(context: AdapterSendContext): Promise<DeliveryReceipt>;
  /** Download provider media only after Channel Core has accepted the sender policy. */
  downloadInbound?(context: AdapterDownloadInboundContext): Promise<DownloadedInboundAttachment[]>;
  beginTurn?(context: AdapterTurnContext): AdapterTurnOutput;
  setTyping?(context: AdapterTypingContext): Promise<void>;
  probe(account: ChannelAccountConfig, secret: ChannelSecret): Promise<ChannelProbeResult>;
  startLogin?(force?: boolean, localTokens?: string[]): Promise<ChannelLoginEvent>;
  pollLogin?(sessionKey: string): Promise<AdapterLoginPollResult>;
  submitLoginCode?(sessionKey: string, code: string): void;
  cancelLogin?(sessionKey: string): void;
}
