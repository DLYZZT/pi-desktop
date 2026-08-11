/** Minimum tenant permissions required by Pi Desktop's Feishu/Lark channel. */
export const FEISHU_REQUIRED_TENANT_SCOPES = [
  "im:message",
  "im:message.p2p_msg:readonly",
  "im:message.group_at_msg:readonly",
  "im:message:send_as_bot",
  "im:message.reactions:write_only",
  "im:resource",
  "cardkit:card:write",
] as const;

/** Events consumed over the existing official-SDK WebSocket connection. */
export const FEISHU_REQUIRED_TENANT_EVENTS = ["im.message.receive_v1", "application.bot.menu_v6"] as const;
