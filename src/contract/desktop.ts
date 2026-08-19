import type { ChannelId } from "../shared/channel-types";
import type { PublicToolchainState, ToolchainActionRequest } from "../shared/toolchains/types";
import type {
  BrowserBoundsInput,
  BrowserConfirmationKind,
  BrowserConfirmationProof,
  BrowserCreateProfileInput,
  BrowserCreateTabInput,
  BrowserDataType,
  BrowserEvent,
  BrowserHeaderRule,
  BrowserHeaderRuleDirection,
  BrowserPermissionDecision,
  BrowserPageSnippetSummary,
  BrowserProfileInfo,
  BrowserProxyCredentialsInput,
  BrowserRendererState,
  BrowserSettingsPatch,
  BrowserSettingsPublic,
  BrowserPersistentSessionPermission,
  BrowserAgentAuthorizationDecision,
  BrowserTabInfo,
} from "./browser";

export type * from "./browser";

export type {
  ManagedComponentId,
  PublicToolchainState,
  ToolCapabilityId,
  ToolPreference,
  ToolchainActionRequest,
  ToolchainCacheId,
  ToolchainProfileId,
} from "../shared/toolchains/types";

export type HostStatus = "starting" | "ready" | "crashed" | "stopped";

export type DesktopMenuEvent =
  "new-session" | "settings" | "check-for-updates" | "show-update" | "switch-session" | "export-diagnostics";

export type UpdatePhase =
  "disabled" | "idle" | "checking" | "up-to-date" | "available" | "downloading" | "downloaded" | "installing" | "error";

export type UpdateErrorCode =
  | "UPDATE_OFFLINE"
  | "UPDATE_NOT_PUBLISHED"
  | "UPDATE_METADATA_INVALID"
  | "UPDATE_SIGNATURE_INVALID"
  | "UPDATE_DOWNLOAD_FAILED"
  | "UPDATE_BUSY"
  | "UPDATE_INVALID_STATE"
  | "UPDATE_UNSUPPORTED"
  | "UPDATE_UNKNOWN";

export interface DesktopUpdateState {
  phase: UpdatePhase;
  currentVersion: string;
  availableVersion?: string;
  releaseName?: string;
  releaseDate?: string;
  releaseNotes?: string;
  percent?: number;
  bytesPerSecond?: number;
  transferred?: number;
  total?: number;
  checkedAt?: string;
  automaticChecksEnabled: boolean;
  installBlockedByActiveSessions: boolean;
  canRetry: boolean;
  error?: { code: UpdateErrorCode; message: string };
}

export interface ChannelCredentialWrite {
  channel: ChannelId;
  accountId: string;
  credential: {
    token: string;
    providerAccountId: string;
    providerUsername?: string;
    baseUrl: string;
  };
}

export interface SaveTextFileOptions {
  content: string;
  defaultPath?: string;
  filters?: { name: string; extensions: string[] }[];
}

export interface SaveBinaryFileOptions {
  base64: string;
  defaultPath?: string;
}

/** The complete, shared preload surface exposed to the sandboxed renderer. */
export interface PiBridge {
  platform: NodeJS.Platform;
  isDesktop: true;
  getVersion: () => Promise<string>;
  getUpdateState: () => Promise<DesktopUpdateState>;
  checkForUpdates: () => Promise<DesktopUpdateState>;
  downloadUpdate: () => Promise<DesktopUpdateState>;
  installUpdate: () => Promise<void>;
  setAutomaticUpdateChecks: (enabled: boolean) => Promise<DesktopUpdateState>;
  getHostStatus: () => Promise<HostStatus>;
  getToolchainState: (cwd?: string) => Promise<PublicToolchainState>;
  rescanToolchains: (cwd?: string) => Promise<PublicToolchainState>;
  performToolchainAction: (request: ToolchainActionRequest) => Promise<PublicToolchainState>;
  requestHostPort: () => void;
  abortSession: (sessionId: string) => void;
  startSessionTui: (session: { sessionId: string; sessionPath?: string; cwd: string }) => void;
  killSessionTui: (sessionId: string) => void;
  writeSessionTui: (sessionId: string, data: string) => void;
  resizeSessionTui: (sessionId: string, cols: number, rows: number) => void;
  getSessionTuiMarks: () => Promise<Record<string, "running" | "dead">>;
  onSessionTuiMarks: (cb: (marks: Record<string, "running" | "dead">) => void) => () => void;
  onSessionTuiData: (cb: (payload: { sessionId: string; data: string }) => void) => () => void;
  onCockpitSelection: (cb: (session: { sessionId: string; sessionPath?: string; cwd: string }) => void) => () => void;
  openExternal: (url: string) => Promise<void>;
  showItemInFolder: (fsPath: string) => Promise<void>;
  selectDirectory: () => Promise<string | null>;
  setChannelCredential: (payload: ChannelCredentialWrite) => Promise<void>;
  saveFile: (opts: SaveTextFileOptions) => Promise<string | null>;
  saveBinaryFile: (opts: SaveBinaryFileOptions) => Promise<string | null>;
  createHtmlPreview: (content: string, filePath: string, sourceSessionId?: string | null) => Promise<string>;
  releaseHtmlPreview: (previewUrl: string) => Promise<void>;
  notifyAgentEnd: (payload: { sessionId: string; title?: string }) => void;
  setBadgeCount: (n: number) => void;
  getUiState: () => Promise<Record<string, unknown>>;
  setUiState: (patch: Record<string, unknown>) => Promise<void>;
  getThemeSource: () => Promise<"system" | "light" | "dark">;
  setThemeSource: (source: "system" | "light" | "dark") => Promise<void>;
  openLogs: () => Promise<void>;
  exportDiagnostics: () => Promise<string | null>;
  browserGetState: () => Promise<BrowserRendererState>;
  browserGetSettings: () => Promise<BrowserSettingsPublic>;
  browserRequestConfirmation: (
    kind: BrowserConfirmationKind,
    payload?: BrowserSettingsPatch,
    language?: "en-US" | "zh-CN",
  ) => Promise<BrowserConfirmationProof | null>;
  browserUpdateSettings: (
    patch: BrowserSettingsPatch,
    confirmation?: BrowserConfirmationProof,
  ) => Promise<BrowserSettingsPublic>;
  browserListTabs: (sessionId?: string) => Promise<BrowserTabInfo[]>;
  browserCreateUserTab: (input: BrowserCreateTabInput) => Promise<BrowserTabInfo>;
  browserActivateTab: (tabId: string) => Promise<void>;
  browserNavigateUser: (tabId: string, url: string) => Promise<void>;
  browserGoBack: (tabId: string) => Promise<void>;
  browserGoForward: (tabId: string) => Promise<void>;
  browserReload: (tabId: string) => Promise<void>;
  browserStop: (tabId: string) => Promise<void>;
  browserCloseTab: (tabId: string) => Promise<void>;
  browserCloseAllTabs: () => Promise<void>;
  browserSetBounds: (input: BrowserBoundsInput) => Promise<void>;
  browserSetSurfaceVisible: (input: { tabId?: string; visible: boolean }) => Promise<void>;
  browserSetPersistentSessionPermission: (
    sessionId: string,
    permission: BrowserPersistentSessionPermission,
  ) => Promise<void>;
  browserRevokeTemporarySessionPermission: (sessionId: string) => Promise<void>;
  browserRespondAgentAuthorization: (requestId: string, decision: BrowserAgentAuthorizationDecision) => Promise<void>;
  browserListProfiles: () => Promise<BrowserProfileInfo[]>;
  browserCreateProfile: (input: BrowserCreateProfileInput) => Promise<BrowserProfileInfo>;
  browserRenameProfile: (profileId: string, name: string) => Promise<BrowserProfileInfo>;
  browserDeleteProfile: (profileId: string) => Promise<void>;
  browserClearProfileData: (profileId: string, dataType: BrowserDataType) => Promise<void>;
  browserSetProxyCredentials: (credentials: BrowserProxyCredentialsInput | null) => Promise<BrowserSettingsPublic>;
  browserGetHeaderRules: (profileId: string, direction: BrowserHeaderRuleDirection) => Promise<BrowserHeaderRule[]>;
  browserSetHeaderRules: (
    profileId: string,
    direction: BrowserHeaderRuleDirection,
    rules: BrowserHeaderRule[],
  ) => Promise<void>;
  browserStoreHeaderSecret: (value: string, existingRef?: string) => Promise<string>;
  browserRemoveHeaderSecret: (secretRef: string) => Promise<void>;
  browserListPageSnippets: () => Promise<BrowserPageSnippetSummary[]>;
  browserSetPageSnippetEnabled: (snippetId: string, enabled: boolean) => Promise<void>;
  browserDeletePageSnippet: (snippetId: string) => Promise<void>;
  browserClearPageSnippets: () => Promise<void>;
  browserRespondPermission: (requestId: string, decision: BrowserPermissionDecision) => Promise<void>;
  browserChooseUploadFiles: (tabId: string) => Promise<string[]>;
  browserReset: () => Promise<BrowserRendererState>;
  clearBadge: () => void;
  onHostStatus: (cb: (s: { status: HostStatus; detail?: string }) => void) => () => void;
  onHostRestarted: (cb: (payload: { reason: string }) => void) => () => void;
  onHostCrashed: (cb: (payload: { detail?: string }) => void) => () => void;
  onUpdateState: (cb: (state: DesktopUpdateState) => void) => () => void;
  onToolchainState: (cb: (state: PublicToolchainState) => void) => () => void;
  onDeepLinkSession: (cb: (sessionId: string) => void) => () => void;
  onBrowserEvent: (cb: (event: BrowserEvent) => void) => () => void;
  onMenu: (event: DesktopMenuEvent, cb: () => void) => () => void;
}
