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
  settingsDescription: "管理应用偏好、模型、技能与插件。",
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
