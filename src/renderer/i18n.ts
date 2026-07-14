import { useCallback, useSyncExternalStore } from "react";

export type AppLanguage = "en-US" | "zh-CN";

const LANGUAGE_STORAGE_KEY = "pi-desktop:language";
const listeners = new Set<() => void>();

const zhCN: Record<string, string> = {
  settings: "设置",
  general: "通用",
  models: "模型",
  skills: "技能",
  plugins: "插件",
  channels: "消息渠道",
  close: "关闭",
  appearance: "外观",
  appearanceDescription: "选择应用使用的颜色模式。",
  theme: "主题",
  light: "浅色",
  dark: "深色",
  interfaceLanguage: "界面语言",
  interfaceLanguageDescription: "选择应用界面所使用的语言，更改会立即生效。",
  language: "语言",
  english: "English",
  simplifiedChinese: "简体中文",
  projectRequiredTitle: "请先选择项目",
  projectRequiredDescription: "技能和插件与当前项目相关。请先从侧边栏选择一个项目目录。",
  hideSidebar: "隐藏侧边栏",
  showSidebar: "显示侧边栏",
  switchToLight: "切换到浅色模式",
  switchToDark: "切换到深色模式",
  hideFilePanel: "隐藏文件面板",
  showFilePanel: "显示文件面板",
  resizeRightPanel: "调整右侧面板宽度",
  sessionInfo: "会话信息",
  getStarted: "开始使用",
  selectProject: "从侧边栏选择一个项目目录",
  addModelsFromSettings: "在底部打开“设置”，然后添加模型",
  selectSession: "从侧边栏选择一个会话",
  refreshExplorer: "刷新文件浏览器",
  settingsDescription: "管理应用偏好、消息渠道、模型、技能与插件。",
  channelsDescription: "连接即时通信账号、控制访问权限，并将对话绑定到 Pi 会话。",
  connectWeixin: "连接微信",
  connectTelegram: "连接 Telegram",
  telegramBotToken: "BotFather Token",
  telegramTokenDescription:
    "通过 @BotFather 创建机器人并粘贴 Token。Pi Desktop 会使用 getMe 验证，并通过系统加密安全保存。",
  telegramBridgeUnavailable: "桌面运行时尚未加载 Telegram 凭证接口。请完全退出并重新启动 Pi Desktop 后重试。",
  saveAndConnect: "保存并连接",
  newTelegramBotToken: "新的 BotFather Token",
  updateTelegramToken: "更新 Token",
  telegramGroupSetupHint: "如需允许群聊，请先将机器人加入群并 @一次，然后从“最近活动”复制群 Chat ID 到“允许的群 ID”。",
  weixin: "微信",
  channelOverview: "渠道总览",
  configured: "已配置",
  configuredAccounts: "个账号已配置",
  noChannels: "尚未配置消息账号。连接微信或 Telegram 即可开始使用。",
  loading: "加载中…",
  channelTestMessage: "Pi Agent Desktop 消息渠道测试",
  channelStatus_starting: "启动中",
  channelStatus_running: "运行中",
  channelStatus_reconnecting: "重连中",
  channelStatus_stopped: "已停止",
  channelStatus_error: "错误",
  notConfigured: "未配置",
  enabled: "已启用",
  channelName: "名称",
  dmAccess: "私聊访问",
  policyPairing: "需要配对",
  policyAllowlistOnly: "仅允许名单",
  policyOpenUnsafe: "开放（不安全）",
  allowedUserIds: "允许的用户 ID",
  groupAccess: "群聊访问",
  policyDisabledRecommended: "禁用（推荐）",
  policyAllowlist: "允许名单",
  allowedGroupIds: "允许的群 ID",
  allowedGroupSenderIds: "允许的群消息发送者 ID",
  groupMentionRequired: "群聊触发条件",
  requireMention: "必须 @提及",
  imCommands: "IM 命令",
  enableImCommands: "启用 /help、/status、/new、/compact 和 /reload",
  defaultTools: "默认工具权限",
  toolPresetNone: "禁用工具（推荐）",
  toolPresetRead: "只读工具",
  toolPresetFull: "完整编码工具",
  defaultProjectDirectory: "默认项目目录",
  isolatedChannelWorkspace: "独立的消息渠道工作区",
  browse: "浏览…",
  elevatedChannelConfirm: "此配置允许远程消息调用高权限本地能力。请确认该账号和允许的用户均可信。",
  start: "启动",
  restart: "重新启动",
  testConnection: "测试连接",
  testingConnection: "正在测试…",
  connectionHealthy: "连接正常",
  delete: "删除",
  testSendUserId: "测试发送的用户 ID",
  testSendTelegramChatId: "测试发送的 Telegram Chat ID",
  testSend: "测试发送",
  deleteChannelConfirm: "删除此消息账号及其所有会话绑定？",
  pairingRequests: "配对请求",
  noPairingRequests: "没有待处理的请求。",
  pairingCode: "配对码",
  expiresAt: "过期时间",
  approve: "批准",
  reject: "拒绝",
  conversationBindings: "会话绑定",
  noConversationBindings: "已批准的用户发送第一条消息后会自动创建绑定。",
  dedicatedImSession: "使用独立 IM 会话",
  topic: "话题",
  deleteBinding: "删除绑定",
  recentActivity: "最近活动",
  recentActivityDescription: "不会记录消息正文；最多保留最近 100 条记录。",
  noChannelActivity: "暂无消息渠道活动。",
  showLatestTwelve: "仅显示最近 12 条",
  showAllActivity: "显示全部",
  activityDirection_inbound: "收到",
  activityDirection_outbound: "发出",
  activityDirection_system: "系统",
  activityOutcome_accepted: "已接受",
  activityOutcome_ignored: "已忽略",
  activityOutcome_sent: "已发送",
  activityOutcome_failed: "失败",
  weixinLoginQrCode: "微信登录二维码",
  verificationNumber: "验证码",
  submit: "提交",
  pollingSecurely: "正在安全地等待微信确认…",
  connectedToWeixin: "已连接到微信",
  boundToWeixinOffline: "已绑定微信（未在线）",
  channelBindingIndicatorTitle: "此 UI 会话已与消息渠道共用",
  conversations: "个对话",
  connectedToChannel: "已连接到",
  connectedToMessagingChannels: "已连接到消息渠道",
  boundToMessagingChannelsOffline: "已绑定消息渠道（未在线）",
  bindMessagingConversation: "绑定消息对话",
  bindChannelToCurrentSession: "将消息对话绑定到当前会话",
  quickChannelBinding: "快速绑定消息渠道",
  quickChannelBindingDescription: "选择要与当前 UI 会话共用上下文的消息对话。",
  noBindableChannelConversations: "暂无可绑定的消息对话。请先让已批准的用户发送第一条消息。",
  bindWeixin: "绑定微信",
  bindWeixinToCurrentSession: "将微信对话绑定到当前会话",
  quickWeixinBinding: "快速绑定微信",
  quickWeixinBindingDescription: "选择要与当前 UI 会话共用上下文的微信对话。",
  noBindableWeixinConversations: "暂无可绑定的微信对话。请先让已批准的用户发送第一条消息。",
  weixinAccount: "微信账号",
  groupConversation: "群聊",
  directConversation: "私聊",
  boundToCurrentSession: "已绑定到当前会话",
  boundToAnotherSession: "已绑定到其他会话",
  unbind: "解除绑定",
  rebindHere: "改绑到这里",
  bindHere: "绑定到这里",
  backgroundMode: "后台运行",
  backgroundModeDescription: "窗口关闭后保持消息渠道在线。",
  closeToTray: "关闭窗口时最小化到托盘",
  currentProject: "当前项目",
  noProject: "未选择项目",
  refresh: "刷新",
  newSession: "新建会话",
  newSessionIn: "在所选项目中新建会话",
  selectProjectFirst: "请先选择项目",
  selectProjectEllipsis: "选择项目…",
  filterProjects: "筛选项目…",
  noMatchingProjects: "没有匹配的项目",
  useDefaultDirectory: "使用默认目录",
  browseFolder: "浏览文件夹…",
  customPath: "自定义路径…",
  checking: "检查中…",
  open: "打开",
  cancel: "取消",
  steerOrQueue: "立即引导 / 排队后续消息…",
  agentRunning: "Agent 正在运行…",
  messagePlaceholder: "输入消息… 输入 / 查看命令，输入 @ 引用文件",
  addProvider: "添加服务商",
  selectProviderOrModel: "选择一个服务商或模型",
  save: "保存",
  saving: "保存中…",
  saved: "已保存",
  addSkill: "添加技能",
  selectSkill: "选择一个技能",
  addPlugin: "添加插件",
  selectPackage: "选择一个插件包",
  thinkingAuto: "自动",
  thinkingOff: "关闭",
  thinkingMinimal: "极低",
  thinkingLow: "低",
  thinkingMedium: "中",
  thinkingHigh: "高",
  thinkingXHigh: "极高",
  thinkingDefaultDescription: "使用 Pi 默认强度",
  thinkingOffDescription: "关闭推理",
  thinkingMinimalDescription: "最低推理强度",
  thinkingLowDescription: "较低推理强度",
  thinkingMediumDescription: "中等推理强度",
  thinkingHighDescription: "较高推理强度",
  thinkingXHighDescription: "最高推理强度",
  changeThinkingLevel: "更改推理强度",
  permissionReadOnly: "只读",
  permissionStandard: "标准",
  permissionFull: "完全访问",
  permissionReadOnlyDescription: "禁用工具，仅可对话",
  permissionStandardDescription: "启用 4 个内置工具",
  permissionFullDescription: "启用所有内置工具",
  changePermission: "更改权限设置",
  send: "发送",
  steer: "立即引导",
  followUp: "后续消息",
  imageQueueUnavailable: "Agent 运行时无法将图片附件加入队列",
  steerDescription: "中断当前运行并立即注入此消息",
  followUpDescription: "在 Agent 完成后发送此消息",
  attachImage: "添加图片",
  more: "更多",
  stop: "停止",
  stopAgent: "停止 Agent",
  waitingForModel: "正在等待模型…",
  runningCommand: "正在运行命令…",
  runningTool: "正在运行工具…",
  runningTools: "正在运行",
  thinking: "正在思考…",
  moreControls: "更多控制项",
  collapseControls: "收起控制项",
  compact: "压缩上下文",
  compacting: "正在压缩…",
  stopCompaction: "停止压缩",
  enableCompletionSound: "开启完成提示音",
  disableCompletionSound: "关闭完成提示音",
  queued: "已排队",
  recallToInput: "撤回到输入框",
  recallQueueDescription: "移除所有排队消息并放回输入框编辑",
  retrying: "正在重试",
  processDetails: "过程详情",
  messagesCount: "条消息",
  toolCallsCount: "次工具调用",
  collapseProcessDetails: "收起过程详情",
  expandProcessDetails: "展开过程详情",
  thinkingLabel: "思考过程",
  collapsed: "已收起",
  usageInput: "输入",
  usageOutput: "输出",
  cacheRead: "缓存读取",
  cacheWrite: "缓存写入",
  usageCost: "费用",
  usageContext: "上下文",
  unknown: "未知",
  sessionName: "名称",
  sessionFile: "文件",
  inMemory: "内存中",
  sessionId: "会话 ID",
  user: "用户",
  assistant: "助手",
  toolCalls: "工具调用",
  toolResults: "工具结果",
  total: "总计",
  messages: "消息",
  tokens: "Token",
  copied: "已复制",
  copyFilePath: "复制文件路径",
  copySessionId: "复制会话 ID",
  loadSessionInfoHint: "发送一条消息或运行 /session 以加载会话信息",
};

const dictionaries: Record<AppLanguage, Record<string, string>> = {
  "en-US": {},
  "zh-CN": zhCN,
};

function detectLanguage(): AppLanguage {
  if (typeof window === "undefined") return "en-US";
  try {
    const saved = window.localStorage.getItem(LANGUAGE_STORAGE_KEY);
    if (saved === "en-US" || saved === "zh-CN") return saved;
  } catch {
    // Storage can be unavailable in privacy-restricted renderer contexts.
  }
  return window.navigator.language.toLowerCase().startsWith("zh") ? "zh-CN" : "en-US";
}

let currentLanguage = detectLanguage();

function applyDocumentLanguage(language: AppLanguage): void {
  if (typeof document !== "undefined") document.documentElement.lang = language;
}

applyDocumentLanguage(currentLanguage);

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function getSnapshot(): AppLanguage {
  return currentLanguage;
}

function getServerSnapshot(): AppLanguage {
  return "en-US";
}

export function setAppLanguage(language: AppLanguage): void {
  if (language === currentLanguage) return;
  currentLanguage = language;
  applyDocumentLanguage(language);
  try {
    window.localStorage.setItem(LANGUAGE_STORAGE_KEY, language);
  } catch {
    // Keep the in-memory preference when persistence is unavailable.
  }
  listeners.forEach((listener) => listener());
}

export function useI18n() {
  const language = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  const t = useCallback(
    (key: string, fallback: string) => {
      return dictionaries[language][key] ?? fallback;
    },
    [language],
  );
  return { language, setLanguage: setAppLanguage, t };
}
