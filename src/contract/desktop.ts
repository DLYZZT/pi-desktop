import type { BrowserDeviceModeInput } from "./browser-device";
import type { AppLanguage } from "../shared/app-language.ts";
import type { ChannelId } from "../shared/channel-types";
import type { ManagedProcessCapability } from "./processes";
import type { ChatAppearancePreferences } from "../shared/chat-appearance";
import type { HerdrSettings } from "./herdr";
import type { SessionListMode } from "../shared/session-list-mode";
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

export type FileContextMenuSource = "local-file-reference" | "rendered-agent-text";
export type FileContextMenuErrorCode = "INVALID_REQUEST" | "NOT_FOUND" | "NOT_A_FILE_OR_DIRECTORY" | "UNAVAILABLE";

export interface ShowFileContextMenuRequest {
  href: string;
  cwd?: string;
  source: FileContextMenuSource;
  language?: "en-US" | "zh-CN" | "zh-TW";
}

export type ShowFileContextMenuResult = { shown: true } | { shown: false; code: FileContextMenuErrorCode };

export interface InspectLocalFilesRequest {
  paths: string[];
  cwd?: string;
}

export interface LocalFileInspection {
  path: string;
  exists: boolean;
  isFile: boolean;
  insideCwd: boolean;
}

export interface RemoteControlConfig {
  enabled: boolean;
  /** Outbound relay endpoint, e.g. ws://127.0.0.1:8788/ws */
  relayUrl: string;
  /**
   * lan: the desktop app hosts the bundled relay locally (zero setup on a
   * trusted LAN). custom: the user points at an external relay (VPS etc).
   */
  mode: "lan" | "custom";
  /** TCP port for the hosted relay in lan mode (default 8788). */
  lanPort?: number;
  /** Display name shown on device selectors (defaults to hostname). */
  name?: string;
  /** Stable host identity so devices remember this PC across restarts. */
  hostId?: string;
  /** Host's static X25519 public key (base64url) — E2EE + QR pairing anchor. */
  e2eePublicKey?: string;
  /**
   * Host's X25519 private key (PKCS8 DER base64). Trusted-process-only:
   * injected into the gateway-bound copy of the config that main forwards to
   * the agent-host child, never persisted to uiState and never sent to the
   * renderer.
   */
  e2eePrivateKey?: string;
}

export interface RelayServiceStatus {
  /** stopped: not requested; running: healthz OK; crashed/port-conflict need UI hints. */
  state: "stopped" | "starting" | "running" | "port-conflict" | "crashed";
  port: number;
  pid?: number;
  detail?: string;
}

export interface LanAddress {
  /** Interface name for disambiguation (e.g. "WLAN", "以太网"). */
  iface: string;
  /** Full relay endpoint reachable from LAN devices: ws://<ip>:<port>/ws */
  url: string;
  /** True for the best-guess physical interface (sorted first in the UI). */
  preferred: boolean;
}

export interface RemoteControlStatus {
  /** disabled: switch off; connecting/ready/stopped: gateway link states. */
  state: "disabled" | "connecting" | "ready" | "stopped";
  relayUrl: string;
  lastError?: string;
}

export interface DesktopUiState {
  language?: AppLanguage;
  backgroundMode?: boolean;
  managedProcessesEnabled?: boolean;
  chatAppearance?: ChatAppearancePreferences;
  herdrSettings?: HerdrSettings;
  sessionListMode?: SessionListMode;
  remoteControl?: RemoteControlConfig;
}

export type DesktopUiStatePatch = Partial<DesktopUiState>;

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
  openExternal: (url: string) => Promise<void>;
  showItemInFolder: (fsPath: string) => Promise<void>;
  /** Show the app's rich file context menu after main-process path validation. */
  showFileContextMenu: (request: ShowFileContextMenuRequest) => Promise<ShowFileContextMenuResult>;
  inspectLocalFiles: (request: InspectLocalFilesRequest) => Promise<LocalFileInspection[]>;
  /** Resolve the absolute filesystem path for a dropped/injected File object. */
  getPathForFile?: (file: File) => string | null;
  selectDirectory: () => Promise<string | null>;
  setChannelCredential: (payload: ChannelCredentialWrite) => Promise<void>;
  saveFile: (opts: SaveTextFileOptions) => Promise<string | null>;
  saveBinaryFile: (opts: SaveBinaryFileOptions) => Promise<string | null>;
  createHtmlPreview: (content: string, filePath: string, sourceSessionId?: string | null) => Promise<string>;
  releaseHtmlPreview: (previewUrl: string) => Promise<void>;
  notifyAgentEnd: (payload: { sessionId: string; title?: string }) => void;
  setBadgeCount: (n: number) => void;
  getUiState: () => Promise<DesktopUiState>;
  getManagedProcessCapability: () => Promise<ManagedProcessCapability>;
  setUiState: (patch: DesktopUiStatePatch) => Promise<void>;
  getRemoteStatus: () => Promise<RemoteControlStatus | null>;
  onRemoteStatus: (cb: (status: RemoteControlStatus) => void) => () => void;
  getRelayServiceStatus: () => Promise<RelayServiceStatus>;
  onRelayServiceStatus: (cb: (status: RelayServiceStatus) => void) => () => void;
  listLanAddresses: () => Promise<LanAddress[]>;
  reconnectRemote: () => Promise<void>;
  getThemeSource: () => Promise<"system" | "light" | "dark">;
  setThemeSource: (source: "system" | "light" | "dark") => Promise<void>;
  openLogs: () => Promise<void>;
  exportDiagnostics: () => Promise<string | null>;
  browserGetState: () => Promise<BrowserRendererState>;
  browserGetSettings: () => Promise<BrowserSettingsPublic>;
  browserRequestConfirmation: (
    kind: BrowserConfirmationKind,
    payload?: BrowserSettingsPatch,
    language?: "en-US" | "zh-CN" | "zh-TW",
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
  browserSetDeviceMode: (tabId: string, device: BrowserDeviceModeInput) => Promise<BrowserTabInfo>;
  browserSetBounds: (input: BrowserBoundsInput) => Promise<void>;
  browserSetSurfaceVisible: (input: { tabId?: string; visible: boolean }) => Promise<void>;
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
