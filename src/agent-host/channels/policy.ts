import type { ChannelAccountConfig, InboundEnvelope } from "../../shared/channel-types";

export type ChannelPolicyDecision = "allow" | "pair" | "ignore";

export function evaluateInboundPolicy(account: ChannelAccountConfig, envelope: InboundEnvelope): ChannelPolicyDecision {
  const senderId = envelope.sender.id;
  if (envelope.peer.kind === "group") {
    if (account.groupPolicy === "disabled") return "ignore";
    if (account.requireMention && !envelope.mentionsBot) return "ignore";
    if (account.groupPolicy === "allowlist" && !account.groupIds.includes(envelope.peer.id)) return "ignore";
    if (account.groupAllowFrom.length > 0 && !account.groupAllowFrom.includes(senderId)) return "ignore";
    return "allow";
  }

  if (account.dmPolicy === "open") return "allow";
  if (account.allowFrom.includes(senderId)) return "allow";
  return account.dmPolicy === "pairing" ? "pair" : "ignore";
}
