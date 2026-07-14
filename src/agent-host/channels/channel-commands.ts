export type ChannelCommandName = "help" | "status" | "new" | "compact" | "reload";

export interface ParsedChannelCommand {
  name: ChannelCommandName;
  args: string;
}

export interface ChannelCommandMenuItem {
  command: ChannelCommandName;
  description: string;
}

const SUPPORTED_COMMANDS = new Set<ChannelCommandName>(["help", "status", "new", "compact", "reload"]);

export const CHANNEL_COMMAND_MENU: readonly ChannelCommandMenuItem[] = [
  { command: "help", description: "显示可用命令" },
  { command: "status", description: "查看当前会话状态" },
  { command: "new", description: "开始新的独立会话" },
  { command: "compact", description: "压缩当前会话上下文" },
  { command: "reload", description: "重新加载扩展和资源" },
];

/**
 * Parse only the built-in, explicitly supported command set. Unknown slash
 * commands deliberately return null so existing Agent prompt routing remains
 * backward compatible.
 */
export function parseChannelCommand(text: string): ParsedChannelCommand | null {
  const match = text.trim().match(/^\/([a-z][a-z0-9_]*)(?:@[a-z0-9_]+)?(?:\s+([\s\S]*))?$/i);
  if (!match) return null;
  const name = match[1].toLowerCase() as ChannelCommandName;
  if (!SUPPORTED_COMMANDS.has(name)) return null;
  return { name, args: (match[2] ?? "").trim() };
}

export function channelCommandHelpText(): string {
  return [
    "可用命令：",
    "/help — 显示本帮助",
    "/status — 查看渠道与会话状态",
    "/new — 开始新的独立会话",
    "/compact [说明] — 压缩当前会话上下文",
    "/reload — 重新加载扩展、Skills、Prompts 和工具",
  ].join("\n");
}
