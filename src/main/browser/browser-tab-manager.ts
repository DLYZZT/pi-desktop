import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import {
  nativeImage,
  WebContentsView,
  type BrowserWindow,
  type Session,
  type WebContents,
  type WebFrameMain,
} from "electron";
import type {
  BrowserAdvancedRuntimePolicy,
  BrowserBoundsInput,
  BrowserClickNavigationResult,
  BrowserClickResult,
  BrowserConsoleEntry,
  BrowserConsoleLevel,
  BrowserConsolePage,
  BrowserCreateTabInput,
  BrowserErrorCode,
  BrowserEvent,
  BrowserIdentityProfile,
  BrowserInputModifier,
  BrowserInspectResult,
  BrowserLoadFailure,
  BrowserNetworkBodyResult,
  BrowserNetworkPage,
  BrowserNetworkReplayResult,
  BrowserNetworkRequest,
  BrowserNetworkSummary,
  BrowserPageSnapshot,
  BrowserProfileInfo,
  BrowserScreenshotMode,
  BrowserScreenshotOptions,
  BrowserScreenshotResult,
  BrowserSettingsV2,
  BrowserSnapshotNode,
  BrowserTabInfo,
  BrowserTabSummary,
  BrowserVisualCompareResult,
  BrowserVisualCompareTarget,
} from "../../contract/browser.ts";
import { BrowserCdpCoordinator } from "./browser-cdp-coordinator.ts";
import { BrowserConsoleBuffer } from "./browser-console-buffer.ts";
import { isBrowserDevToolsShortcut } from "./browser-devtools-shortcut.ts";
import { BrowserError } from "./browser-error.ts";
import { BrowserIdentityManager } from "./browser-identity-manager.ts";
import { BrowserInspectionStore } from "./browser-inspection-store.ts";
import { BrowserNetworkRecorder } from "./browser-network-recorder.ts";
import { BrowserNetworkPolicy, createSessionNetworkPolicyOptions } from "./browser-network-policy.ts";
import { redactBrowserText, redactBrowserUrl } from "./browser-redaction.ts";
import type { BrowserProfileManager } from "./browser-profile-manager.ts";
import {
  MAX_REPLAY_RESPONSE_BYTES,
  readBoundedResponseBody,
  runBoundedNetworkAction,
} from "./browser-response-body.ts";
import { canResumeSensitiveAgentControl } from "./browser-sensitive-control.ts";

const SNAPSHOT_WORLD_ID = 99_911;
const MAX_SCREENSHOT_BYTES = 12 * 1024 * 1024;
const MAX_INSPECTION_SCREENSHOT_BYTES = 1_500_000;
const MAX_INSPECTION_NODE_CHARS = 40_000;
const DEFAULT_INSPECTION_MAX_NODES = 100;
const DEFAULT_INSPECTION_MAX_TEXT_CHARS = 8_000;
const DEFAULT_INSPECTION_NODE_CHARS = 16_000;
const MAX_FULL_PAGE_HEIGHT = 16_384;
const MAX_SCREENSHOT_PIXELS = 32_000_000;
const MAX_COMPARE_PIXELS = 16_000_000;
const MAX_SCRIPT_BYTES = 256 * 1024;
const MAX_SCRIPT_RESULT_BYTES = 2 * 1024 * 1024;
const KEY_PATTERN =
  /^(Enter|Tab|Escape|Backspace|Delete|Arrow(Up|Down|Left|Right)|Home|End|Page(Up|Down)|F[1-9]|F1[0-2]|[A-Za-z0-9])$/;

type SnapshotState = {
  id: string;
  generation: number;
  refs: Set<string>;
  nodes: Map<string, BrowserSnapshotNode>;
  frames: Map<string, { frame: WebFrameMain; offsetX: number; offsetY: number }>;
};

type SnapshotTruncation = {
  text: boolean;
  nodes: boolean;
};

type CapturedSnapshot = {
  snapshot: BrowserPageSnapshot;
  truncated: SnapshotTruncation;
};

type TabRecord = {
  view: WebContentsView;
  info: BrowserTabInfo;
  session: Session;
  snapshot?: SnapshotState;
  queue: Promise<void>;
  activeAbort?: AbortController;
  pendingActions: Map<AbortController, { code: BrowserErrorCode; message: string } | null>;
  controlGeneration: number;
  syntheticInput: number;
  bounds?: Electron.Rectangle;
  advancedReady: Promise<void>;
  networkRecorder?: BrowserNetworkRecorder;
  consoleBuffer?: BrowserConsoleBuffer;
  identityProfile?: BrowserIdentityProfile;
  nativeUserAgent: string;
  externalProtocolToken: string;
  lastLoadFailure?: BrowserLoadFailure;
  activeClickCapture?: { observation?: ClickNavigationObservation };
  pendingFileUpload?: { snapshotId: string; ref: string; generation: number };
};

type ClickNavigationObservation =
  { kind: "same-tab" } | { kind: "new-tab"; result: Promise<BrowserClickNavigationResult> };

const CLICK_NAVIGATION_DETECTION_MS = 250;

export interface BrowserTabManagerOptions {
  getWindow: () => BrowserWindow | null;
  profiles: BrowserProfileManager;
  getSettings: () => BrowserSettingsV2;
  getAdvancedRuntimePolicy: () => BrowserAdvancedRuntimePolicy;
  networkBodyRoot: string;
  emit: (event: BrowserEvent) => void;
  confirmSensitiveAction?: (description: string) => Promise<boolean>;
  openExternal?: (url: string) => Promise<void>;
  confirmPrivateNetwork?: (url: string) => Promise<boolean>;
  approvePrivateOrigin?: (profileId: string, origin: string) => void;
  createView?: (
    profile: BrowserProfileInfo,
    session: Session,
    advanced: BrowserAdvancedRuntimePolicy,
  ) => WebContentsView;
  now?: () => number;
  networkBodyCaptureIdleMs?: number;
}

export class BrowserTabManager {
  private readonly options: BrowserTabManagerOptions;
  private readonly tabs = new Map<string, TabRecord>();
  private readonly networkPolicies = new Map<string, BrowserNetworkPolicy>();
  private activeTabId: string | null = null;
  private surfaceVisible = false;
  private surfaceRequestedVisible = false;
  private windowVisible = true;
  private readonly locallyApprovedPrivateOrigins = new Set<string>();
  private readonly cdp = new BrowserCdpCoordinator();
  private readonly identity = new BrowserIdentityManager(this.cdp);
  private readonly inspections = new BrowserInspectionStore();
  private readonly nativeSessionUserAgents = new Map<string, string>();
  private disposed = false;

  constructor(options: BrowserTabManagerOptions) {
    this.options = options;
  }

  list(sessionId?: string): BrowserTabInfo[] {
    return [...this.tabs.values()]
      .filter(({ info }) => sessionId === undefined || info.ownerSessionId === sessionId)
      .sort((left, right) => left.info.createdAt - right.info.createdAt)
      .map(({ info }) => structuredClone(info));
  }

  getActiveTabId(): string | null {
    return this.activeTabId;
  }

  getOwnedTabUrl(tabId: string, sessionId: string): string {
    return this.requireOwnedTab(tabId, sessionId).info.url;
  }

  countCapturedRequests(): number {
    return [...this.tabs.values()].reduce((total, record) => total + (record.networkRecorder?.count() ?? 0), 0);
  }

  isSurfaceVisible(): boolean {
    return this.surfaceVisible;
  }

  getTabForWebContents(webContentsId: number): { tabId: string; visible: boolean; sessionId?: string } | undefined {
    for (const record of this.tabs.values()) {
      const contents = record.view.webContents as WebContents | undefined;
      if (!contents || contents.id !== webContentsId) continue;
      return {
        tabId: record.info.id,
        visible: record.info.visible,
        ...(record.info.ownerSessionId ? { sessionId: record.info.ownerSessionId } : {}),
      };
    }
    return undefined;
  }

  getIdentityForWebContents(webContentsId: number): BrowserIdentityProfile | undefined {
    for (const record of this.tabs.values()) {
      const contents = record.view.webContents as WebContents | undefined;
      if (!contents || contents.id !== webContentsId || !record.identityProfile) continue;
      return structuredClone(record.identityProfile);
    }
    return undefined;
  }

  hasWebContents(webContentsId: number): boolean {
    return [...this.tabs.values()].some(
      (record) => (record.view.webContents as WebContents | undefined)?.id === webContentsId,
    );
  }

  isAdvancedWebContents(webContentsId: number): boolean {
    return [...this.tabs.values()].some(
      (record) =>
        (record.view.webContents as WebContents | undefined)?.id === webContentsId &&
        this.options.profiles.get(record.info.profileId).mode === "unsafe",
    );
  }

  isAdvancedProfileTab(tabId: string, sessionId?: string): boolean {
    const record = this.requireOwnedTab(tabId, sessionId);
    return this.options.profiles.get(record.info.profileId).mode === "unsafe";
  }

  async create(
    input: BrowserCreateTabInput = {},
    navigationOptions?: Electron.LoadURLOptions,
  ): Promise<BrowserTabInfo> {
    this.assertAvailable();
    const settings = this.options.getSettings();
    if (!settings.enabled) throw new BrowserError("BROWSER_DISABLED", "Built-in Browser is disabled");
    if (this.tabs.size >= settings.navigation.maxTabs) {
      throw new BrowserError("INVALID_BROWSER_REQUEST", "Maximum Browser tab count reached");
    }
    if (input.ownerSessionId) {
      const sessionTabs = [...this.tabs.values()].filter(
        ({ info }) => info.ownerSessionId === input.ownerSessionId,
      ).length;
      if (sessionTabs >= settings.navigation.maxTabsPerSession) {
        throw new BrowserError("INVALID_BROWSER_REQUEST", "Maximum Browser tabs for this session reached");
      }
    }
    const configuredDefault = settings.panel.defaultProfileId;
    let profile: BrowserProfileInfo;
    try {
      profile = this.options.profiles.get(input.profileId ?? configuredDefault);
    } catch (error) {
      if (input.profileId) throw error;
      profile = this.options.profiles.get("temporary");
    }
    const advancedPolicy = this.options.getAdvancedRuntimePolicy();
    if (profile.mode === "unsafe" && !advancedPolicy.enabled) {
      throw new BrowserError("ADVANCED_BROWSER_MODE_REQUIRED", "Advanced Profiles require Advanced Browser Mode");
    }
    const session = this.options.profiles.getSession(profile.id);
    const nativeUserAgent = this.nativeSessionUserAgents.get(profile.id) ?? session.getUserAgent();
    this.nativeSessionUserAgents.set(profile.id, nativeUserAgent);
    const view = (this.options.createView ?? createSecureView)(profile, session, advancedPolicy);
    const id = randomUUID();
    const now = this.options.now?.() ?? Date.now();
    const record: TabRecord = {
      view,
      session,
      info: {
        id,
        ownerSessionId: input.ownerSessionId ?? null,
        profileId: profile.id,
        url: "about:blank",
        title: "New tab",
        generation: 0,
        visible: false,
        loading: false,
        canGoBack: false,
        canGoForward: false,
        crashed: false,
        control: "user",
        advanced: false,
        advancedProfile: profile.mode === "unsafe",
        createdAt: now,
        lastActiveAt: now,
      },
      queue: Promise.resolve(),
      pendingActions: new Map(),
      controlGeneration: 0,
      syntheticInput: 0,
      advancedReady: Promise.resolve(),
      nativeUserAgent,
      externalProtocolToken: randomUUID(),
    };
    this.tabs.set(id, record);
    this.cdp.register(id, view.webContents);
    this.installTabListeners(record);
    const win = this.options.getWindow();
    if (!win || win.isDestroyed()) {
      this.tabs.delete(id);
      view.webContents.close();
      throw new BrowserError("BROWSER_DISABLED", "Main window is unavailable");
    }
    win.contentView.addChildView(view);
    view.setVisible(false);
    // A newly constructed WebContents has not necessarily committed its initial
    // document yet. Commit about:blank before attaching CDP domains so the
    // identity/network barrier never races target initialization.
    try {
      if (view.webContents.getURL() !== "about:blank") {
        await view.webContents.loadURL("about:blank");
      }
      record.advancedReady = this.prepareAdvancedRecord(record);
      await record.advancedReady;
      this.options.emit({ type: "tab-created", tab: structuredClone(record.info) });
      if (input.activate !== false) this.activate(id);
      const url = input.url ?? settings.navigation.homepage;
      if (url !== "about:blank") {
        await this.navigate(id, url, input.ownerSessionId ?? undefined, !input.ownerSessionId, navigationOptions);
      }
      return structuredClone(record.info);
    } catch (error) {
      // A failed initial navigation must not leave an owned about:blank tab or
      // native View behind. Callers can retry after changing policy.
      if (this.tabs.has(id)) this.close(id);
      throw error;
    }
  }

  activate(tabId: string): void {
    const record = this.requireTab(tabId);
    this.activeTabId = record.info.id;
    record.info.lastActiveAt = this.options.now?.() ?? Date.now();
    for (const candidate of this.tabs.values()) {
      const visible = this.surfaceVisible && candidate === record;
      candidate.info.visible = visible;
      candidate.view.setVisible(visible);
      if (visible && candidate.bounds) candidate.view.setBounds(candidate.bounds);
      this.emitUpdate(candidate);
    }
    this.options.emit({ type: "active-tab-changed", tabId: record.info.id });
  }

  setSurfaceVisible(input: { tabId?: string; visible: boolean }): void {
    // Renderer effects can race a tab close by one frame. A visibility update
    // for that stale tab must not overwrite the replacement tab's state or
    // surface an expected TAB_NOT_FOUND error to the user.
    if (input.tabId && !this.tabs.has(input.tabId)) return;
    this.surfaceRequestedVisible = input.visible;
    if (input.tabId) this.activeTabId = this.requireTab(input.tabId).info.id;
    this.applySurfaceVisibility();
  }

  setWindowVisible(visible: boolean): void {
    this.windowVisible = visible;
    this.applySurfaceVisibility();
  }

  hideSurfaceForRendererUnavailable(): void {
    // Do not emit Browser events while the app Renderer is reloading or gone:
    // webContents.send may have no live main frame, and one failed send must not
    // leave another native View visible. The replacement Renderer obtains this
    // state through browserGetState before it can request visibility again.
    this.surfaceRequestedVisible = false;
    this.surfaceVisible = false;
    for (const record of this.tabs.values()) {
      record.info.visible = false;
      try {
        record.view.setVisible(false);
      } catch {
        // Continue hiding the remaining Views if one is already being torn down.
      }
    }
  }

  private applySurfaceVisibility(): void {
    this.surfaceVisible = this.surfaceRequestedVisible && this.windowVisible;
    for (const record of this.tabs.values()) {
      const visible = this.surfaceVisible && record.info.id === this.activeTabId;
      record.info.visible = visible;
      if (visible) {
        if (record.bounds) record.view.setBounds(record.bounds);
      }
      record.view.setVisible(visible);
      this.emitUpdate(record);
    }
  }

  setBounds(input: BrowserBoundsInput): void {
    // ResizeObserver callbacks have the same close race as visibility effects.
    const record = this.tabs.get(input.tabId);
    if (!record) return;
    const win = this.options.getWindow();
    if (!win || win.isDestroyed()) throw new BrowserError("BROWSER_DISABLED", "Main window is unavailable");
    const content = win.getContentBounds();
    const rect = input.rect;
    if (![rect.x, rect.y, rect.width, rect.height].every(Number.isFinite)) {
      throw new BrowserError("INVALID_BROWSER_REQUEST", "Browser surface bounds are invalid");
    }
    const x = Math.max(0, Math.min(Math.round(rect.x), Math.max(0, content.width - 1)));
    const y = Math.max(0, Math.min(Math.round(rect.y), Math.max(0, content.height - 1)));
    const width = Math.max(1, Math.min(Math.round(rect.width), content.width - x));
    const height = Math.max(1, Math.min(Math.round(rect.height), content.height - y));
    record.bounds = { x, y, width, height };
    // Hidden owned tabs still need a real surface size for screenshots and
    // visual comparisons. setVisible(false) prevents presentation over the UI.
    record.view.setBounds(record.bounds);
  }

  async navigate(
    tabId: string,
    rawUrl: string,
    sessionId?: string,
    userInitiated = false,
    navigationOptions?: Electron.LoadURLOptions,
  ): Promise<BrowserTabInfo> {
    const record = this.requireOwnedTab(tabId, sessionId);
    const url = normalizeAddress(rawUrl);
    const policy = this.getNetworkPolicy(record);
    const checked = await policy.check(url, {
      settings: this.options.getSettings().navigation,
      allowAboutBlank: true,
      userApprovedPrivateNetwork: userInitiated,
    });
    if (checked.privateNetwork && !this.options.getSettings().navigation.allowPrivateNetwork) {
      if (!userInitiated) {
        throw new BrowserError("PRIVATE_NETWORK_BLOCKED", "Agent navigation to a private network target is blocked");
      }
      const origin = new URL(checked.url).origin;
      const approvalKey = `${record.info.profileId}\0${origin}`;
      if (!this.locallyApprovedPrivateOrigins.has(approvalKey)) {
        const approved = await (this.options.confirmPrivateNetwork?.(checked.url) ?? Promise.resolve(false));
        if (!approved) throw new BrowserError("PRIVATE_NETWORK_BLOCKED", "Private network navigation was not approved");
        this.locallyApprovedPrivateOrigins.add(approvalKey);
      }
      this.options.approvePrivateOrigin?.(record.info.profileId, origin);
    }
    await record.advancedReady;
    record.networkRecorder?.armBodyCapture();
    try {
      await this.runAction(record, sessionId, "read", async (signal) => {
        await withTimeout(
          record.view.webContents.loadURL(checked.url, navigationOptions),
          this.options.getSettings().navigation.navigationTimeoutMs,
          "ACTION_TIMEOUT",
          signal,
        );
      });
      if (record.lastLoadFailure) throw navigationFailureError(record.lastLoadFailure);
    } catch (error) {
      if (
        error instanceof BrowserError &&
        error.code !== "ACTION_TIMEOUT" &&
        error.code !== "INVALID_BROWSER_REQUEST"
      ) {
        throw error;
      }
      throw navigationFailureError(error);
    }
    return structuredClone(record.info);
  }

  async goBack(tabId: string, sessionId?: string): Promise<BrowserTabInfo> {
    return this.historyAction(tabId, sessionId, "back");
  }

  async goForward(tabId: string, sessionId?: string): Promise<BrowserTabInfo> {
    return this.historyAction(tabId, sessionId, "forward");
  }

  async reload(tabId: string, sessionId?: string): Promise<BrowserTabInfo> {
    const record = this.requireOwnedTab(tabId, sessionId);
    if (record.info.crashed) record.info.crashed = false;
    record.networkRecorder?.armBodyCapture();
    await this.runAction(record, sessionId, "read", async () => {
      record.view.webContents.reload();
      await this.waitForLoad(record, this.options.getSettings().navigation.navigationTimeoutMs);
    });
    return structuredClone(record.info);
  }

  stop(tabId: string): void {
    const record = this.requireTab(tabId);
    record.view.webContents.stop();
  }

  async snapshot(
    tabId: string,
    sessionId: string,
    options: { maxNodes?: number; maxTextChars?: number } = {},
  ): Promise<BrowserPageSnapshot> {
    const record = this.requireOwnedTab(tabId, sessionId);
    const maxNodes = clampInteger(options.maxNodes ?? 400, 1, 2_000);
    const maxTextChars = clampInteger(options.maxTextChars ?? 40_000, 1_000, 200_000);
    return this.runAction(record, sessionId, "read", async (signal) => {
      const captured = await this.captureSnapshot(record, maxNodes, maxTextChars, signal);
      return captured.snapshot;
    });
  }

  async inspect(
    sessionId: string,
    input: {
      tabId?: string;
      sinceInspectionId?: string;
      maxNodes?: number;
      maxTextChars?: number;
      screenshot?: { enabled: boolean; format?: "png" | "jpeg"; quality?: number };
    } = {},
  ): Promise<BrowserInspectResult> {
    const record = this.resolveInspectionTab(input.tabId, sessionId);
    const maxNodes = clampInteger(input.maxNodes ?? DEFAULT_INSPECTION_MAX_NODES, 1, 1_000);
    const maxTextChars = clampInteger(input.maxTextChars ?? DEFAULT_INSPECTION_MAX_TEXT_CHARS, 250, 60_000);
    const nodeCharBudget = input.maxNodes === undefined ? DEFAULT_INSPECTION_NODE_CHARS : MAX_INSPECTION_NODE_CHARS;
    const screenshotEnabled = input.screenshot?.enabled === true;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        return await this.runAction(record, sessionId, "read", async (signal) => {
          const startGeneration = record.info.generation;
          const captured = await this.captureSnapshot(record, maxNodes, maxTextChars, signal);
          const bounded = boundInspectionSnapshot(record, captured.snapshot, nodeCharBudget);
          const snapshot = bounded.snapshot;
          let screenshot: BrowserScreenshotResult | undefined;
          let screenshotUnavailable = false;
          if (screenshotEnabled) {
            try {
              screenshot = await this.captureScreenshot(record, {
                mode: "viewport",
                format: input.screenshot?.format ?? "jpeg",
                quality: input.screenshot?.quality ?? 70,
              });
            } catch (error) {
              if (
                error instanceof BrowserError &&
                ["INSPECTION_STALE", "TAB_NOT_FOUND", "TAB_NOT_OWNED", "TAB_CRASHED"].includes(error.code)
              ) {
                throw error;
              }
              screenshotUnavailable = true;
            }
          }
          if (record.info.generation !== startGeneration || snapshot.generation !== startGeneration) {
            throw new BrowserError("INSPECTION_STALE", "Browser page changed during inspection", {
              details: { reason: "generation-changed" },
            });
          }
          const screenshotBytes = screenshot ? Buffer.byteLength(screenshot.base64, "base64") : 0;
          const screenshotTruncated = screenshotBytes > MAX_INSPECTION_SCREENSHOT_BYTES;
          const contentHash = createHash("sha256")
            .update(
              JSON.stringify({
                generation: startGeneration,
                url: snapshot.url,
                title: snapshot.title,
                loading: record.info.loading,
                text: snapshot.text,
                nodes: snapshot.nodes,
              }),
            )
            .digest("hex");
          const viewportHash = screenshot
            ? createHash("sha256").update(screenshot.base64).digest("hex")
            : "screenshot-disabled";
          const state = this.inspections.record({
            sessionId,
            tabId: record.info.id,
            generation: startGeneration,
            contentHash,
            viewportHash,
            sinceInspectionId: input.sinceInspectionId,
          });
          const ownedTabs = this.list(sessionId);
          const tabs = ownedTabs.slice(0, 20).map(tabSummary);
          return {
            inspectionId: state.inspectionId,
            tabId: record.info.id,
            generation: startGeneration,
            tabs,
            url: redactBrowserUrl(record.info.url),
            title: record.info.title.slice(0, 512),
            loading: record.info.loading,
            changed: state.changed,
            ...(state.changed ? { snapshot } : {}),
            ...(state.changed && screenshot && !screenshotTruncated ? { screenshot } : {}),
            truncated: {
              text: captured.truncated.text,
              nodes: captured.truncated.nodes || bounded.nodesTruncated,
              screenshot: screenshotTruncated || screenshotUnavailable,
              tabs: ownedTabs.length > tabs.length,
            },
            untrustedWebContent: true,
          };
        });
      } catch (error) {
        if (
          !(error instanceof BrowserError) ||
          error.code !== "INSPECTION_STALE" ||
          error.details?.reason !== "generation-changed" ||
          attempt > 0
        ) {
          throw error;
        }
      }
    }
    throw new BrowserError("INSPECTION_STALE", "Browser page changed during inspection");
  }

  async screenshot(
    tabId: string,
    sessionId: string,
    options: BrowserScreenshotOptions = {},
  ): Promise<BrowserScreenshotResult> {
    const record = this.requireOwnedTab(tabId, sessionId);
    return this.runAction(record, sessionId, "read", () => this.captureScreenshot(record, options));
  }

  private async captureSnapshot(
    record: TabRecord,
    maxNodes: number,
    maxTextChars: number,
    signal: AbortSignal,
  ): Promise<CapturedSnapshot> {
    record.pendingFileUpload = undefined;
    const snapshotId = randomUUID();
    const generation = record.info.generation;
    const contexts = await collectFrameContexts(record.view.webContents);
    const nodes: BrowserSnapshotNode[] = [];
    const textParts: string[] = [];
    const frameRefs = new Map<string, { frame: WebFrameMain; offsetX: number; offsetY: number }>();
    let textLength = 0;
    let textTruncated = false;
    let nodesTruncated = false;
    for (const [frameIndex, context] of contexts.entries()) {
      if (nodes.length >= maxNodes || textLength >= maxTextChars) {
        // At least this frame remains unread, so either limit may have hidden
        // additional page text or interactive nodes.
        nodesTruncated = true;
        textTruncated = true;
        break;
      }
      const remainingNodes = maxNodes - nodes.length;
      const remainingText = maxTextChars - textLength;
      let result: unknown;
      try {
        result = await withTimeout(
          context.frame.executeJavaScript(
            createSnapshotScript(snapshotId, remainingNodes, remainingText, nodes.length),
          ),
          this.options.getSettings().navigation.actionTimeoutMs,
          "ACTION_TIMEOUT",
          signal,
        );
      } catch {
        continue;
      }
      const parsed = validateSnapshotResult(result);
      const frameId = `f${frameIndex}`;
      for (const node of parsed.nodes) {
        const adjusted: BrowserSnapshotNode = {
          ...node,
          frameId,
          frameUrl: redactBrowserUrl(context.frame.url),
          ...(node.bounds
            ? {
                bounds: {
                  x: node.bounds.x + context.offsetX,
                  y: node.bounds.y + context.offsetY,
                  width: node.bounds.width,
                  height: node.bounds.height,
                },
              }
            : {}),
        };
        nodes.push(adjusted);
        frameRefs.set(node.ref, context);
      }
      if (parsed.text) {
        textParts.push(parsed.text);
        textLength += parsed.text.length + 1;
      }
      textTruncated ||= parsed.textTruncated;
      nodesTruncated ||= parsed.nodesTruncated;
    }
    if (record.info.generation !== generation) {
      throw new BrowserError("INSPECTION_STALE", "Browser page changed while collecting a snapshot", {
        details: { reason: "generation-changed" },
      });
    }
    record.snapshot = {
      id: snapshotId,
      generation,
      refs: new Set(nodes.map((node) => node.ref)),
      nodes: new Map(nodes.map((node) => [node.ref, node])),
      frames: frameRefs,
    };
    return {
      snapshot: {
        tabId: record.info.id,
        snapshotId,
        generation,
        url: redactBrowserUrl(record.info.url),
        title: record.info.title,
        text: textParts.join("\n").slice(0, maxTextChars),
        nodes,
        truncated: textTruncated || nodesTruncated,
        untrustedWebContent: true,
      },
      truncated: {
        text: textTruncated,
        nodes: nodesTruncated,
      },
    };
  }

  private async captureScreenshot(
    record: TabRecord,
    options: BrowserScreenshotOptions,
  ): Promise<BrowserScreenshotResult> {
    const format = options.format ?? "png";
    const quality = options.quality ?? 85;
    const mode = options.mode ?? "viewport";
    const generation = record.info.generation;
    if (mode === "element") {
      if (!options.snapshotId || !options.ref || options.generation === undefined) {
        throw new BrowserError("INVALID_BROWSER_REQUEST", "Element screenshot requires a snapshot reference");
      }
      this.assertSnapshotRef(record, options.ref, options.snapshotId, options.generation);
    }
    let image: Electron.NativeImage | undefined;
    let captureError: unknown;
    if (mode !== "full-page") {
      const rect =
        mode === "element"
          ? screenshotRectForNode(record.snapshot?.nodes.get(options.ref!), MAX_SCREENSHOT_PIXELS)
          : undefined;
      for (let attempt = 0; attempt < 3; attempt += 1) {
        try {
          image = await withTimeout(
            record.view.webContents.capturePage(rect, { stayHidden: true, stayAwake: true }),
            3_000,
            "ACTION_TIMEOUT",
          );
          if (!image.isEmpty()) break;
        } catch (error) {
          captureError = error;
        }
        await abortableDelay(100);
      }
      if (mode === "viewport" && (!image || image.isEmpty())) {
        try {
          image = await capturePresentedFrame(record.view.webContents, 3_000);
        } catch (error) {
          captureError = error;
        }
      }
    }
    let buffer: Buffer;
    let size: Electron.Size;
    if (image && !image.isEmpty()) {
      size = image.getSize();
      buffer = format === "jpeg" ? image.toJPEG(clampInteger(quality, 1, 100)) : image.toPNG();
    } else {
      const clip = await this.screenshotClip(record, mode, options);
      if (clip.width * clip.height > MAX_SCREENSHOT_PIXELS) {
        throw new BrowserError("RESULT_TOO_LARGE", "Browser screenshot exceeds the pixel limit");
      }
      const releaseDebugger = this.cdp.acquire(record.info.id);
      try {
        const captured = (await withTimeout(
          this.cdp.sendCommand(record.info.id, "Page.captureScreenshot", {
            format,
            ...(format === "jpeg" ? { quality: clampInteger(quality, 1, 100) } : {}),
            fromSurface: true,
            captureBeyondViewport: mode === "full-page",
            clip: { ...clip, scale: 1 },
          }),
          8_000,
          "ACTION_TIMEOUT",
        )) as { data?: string };
        if (!captured.data) throw captureError ?? new Error("CDP screenshot returned no data");
        buffer = Buffer.from(captured.data, "base64");
        size = nativeImage.createFromBuffer(buffer).getSize();
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        const nativeReason = captureError instanceof Error ? captureError.message : String(captureError ?? "none");
        throw new BrowserError(
          "ACTION_TIMEOUT",
          `Browser screenshot surface is not ready (${reason}; native=${nativeReason})`,
          {
            retryable: true,
            cause: error,
          },
        );
      } finally {
        releaseDebugger();
      }
    }
    if (record.info.generation !== generation) {
      throw new BrowserError("INSPECTION_STALE", "Browser page changed during screenshot", {
        details: { reason: "generation-changed" },
      });
    }
    if (buffer.byteLength > MAX_SCREENSHOT_BYTES) {
      throw new BrowserError("RESULT_TOO_LARGE", "Browser screenshot exceeds the result size limit");
    }
    return {
      tabId: record.info.id,
      mime: format === "jpeg" ? "image/jpeg" : "image/png",
      base64: buffer.toString("base64"),
      width: size.width,
      height: size.height,
      mode,
      generation,
      untrustedWebContent: true,
    };
  }

  private async screenshotClip(
    record: TabRecord,
    mode: BrowserScreenshotMode,
    options: BrowserScreenshotOptions,
  ): Promise<{ x: number; y: number; width: number; height: number }> {
    if (mode === "element") {
      return screenshotRectForNode(record.snapshot?.nodes.get(options.ref!), MAX_SCREENSHOT_PIXELS);
    }
    if (mode === "full-page") {
      const releaseDebugger = this.cdp.acquire(record.info.id);
      try {
        const metrics = await this.cdp.sendCommand<{
          cssContentSize?: { width?: number; height?: number };
        }>(record.info.id, "Page.getLayoutMetrics");
        const width = clampInteger(Number(metrics.cssContentSize?.width), 1, 8_192);
        const rawHeight = Number(metrics.cssContentSize?.height);
        if (!Number.isFinite(rawHeight) || rawHeight <= 0 || rawHeight > MAX_FULL_PAGE_HEIGHT) {
          throw new BrowserError("RESULT_TOO_LARGE", "Browser full-page screenshot exceeds the height limit");
        }
        return { x: 0, y: 0, width, height: Math.ceil(rawHeight) };
      } finally {
        releaseDebugger();
      }
    }
    const viewport = (await record.view.webContents.executeJavaScriptInIsolatedWorld(SNAPSHOT_WORLD_ID, [
      { code: "({ width: Math.max(1, innerWidth), height: Math.max(1, innerHeight) })" },
    ])) as { width?: unknown; height?: unknown };
    return {
      x: 0,
      y: 0,
      width: clampInteger(Number(viewport.width), 1, 8_192),
      height: clampInteger(Number(viewport.height), 1, 8_192),
    };
  }

  async click(
    tabId: string,
    sessionId: string,
    ref: string,
    snapshotId: string,
    generation: number,
    button: "left" | "middle" | "right" = "left",
    clickCount: 1 | 2 = 1,
    modifiers: BrowserInputModifier[] = [],
  ): Promise<BrowserClickResult> {
    modifiers = validateInputModifiers(modifiers);
    if (!["left", "middle", "right"].includes(button) || (clickCount !== 1 && clickCount !== 2)) {
      throw new BrowserError("INVALID_BROWSER_REQUEST", "Browser click options are invalid");
    }
    const record = this.requireOwnedTab(tabId, sessionId);
    this.assertSnapshotRef(record, ref, snapshotId, generation);
    return this.runAction(record, sessionId, "interact", async (signal) => {
      record.pendingFileUpload = undefined;
      const node = record.snapshot?.nodes.get(ref);
      if (node && isSensitiveNode(node)) {
        await this.approveSensitiveAction(record, `Click ${node.name || node.role}`);
      }
      const frameContext = record.snapshot?.frames.get(ref);
      if (!frameContext) throw new BrowserError("STALE_ELEMENT_REF", "Browser frame is no longer available");
      const point = await withTimeout(
        frameContext.frame.executeJavaScript(elementPointScript(snapshotId, ref, node?.role === "file-upload")),
        this.options.getSettings().navigation.actionTimeoutMs,
        "ACTION_TIMEOUT",
        signal,
      );
      if (!isPoint(point)) throw new BrowserError("STALE_ELEMENT_REF", "Browser element is no longer actionable");
      point.x += frameContext.offsetX;
      point.y += frameContext.offsetY;
      if (point.externalUrl) {
        if (!/^mailto:/i.test(point.externalUrl)) {
          throw new BrowserError("UNSUPPORTED_PROTOCOL", "External Browser protocol is not allowed");
        }
        await (this.options.openExternal?.(point.externalUrl) ?? Promise.resolve());
        return {
          ok: true,
          action: "external-protocol",
          tabId,
          url: record.info.url,
          generation: record.info.generation,
        };
      }
      const capture: NonNullable<TabRecord["activeClickCapture"]> = {};
      record.activeClickCapture = capture;
      let sendingSyntheticInput = false;
      try {
        if (this.options.getSettings().automation.showActionHighlight) {
          await frameContext.frame.executeJavaScript(elementHighlightScript(snapshotId, ref, true));
          await abortableDelay(120, signal);
        }
        record.syntheticInput += 1;
        sendingSyntheticInput = true;
        await this.sendMouseClick(record, point.x, point.y, button, clickCount, signal, modifiers);
        // Chromium delivers synthetic mouse events asynchronously. Keep the
        // synthetic-input guard through the next task so they cannot be mistaken
        // for a local user takeover.
        if (node?.role !== "file-upload") await abortableDelay(0, signal);
      } finally {
        if (!record.view.webContents.isDestroyed()) {
          void frameContext.frame
            .executeJavaScript(elementHighlightScript(snapshotId, ref, false))
            .catch(() => undefined);
        }
        if (sendingSyntheticInput) record.syntheticInput -= 1;
      }
      try {
        // File inputs hand control to the local upload picker. Return as soon as
        // Chromium has focused the input; waiting for navigation would allow the
        // native chooser lifecycle to clear that focus before file injection.
        if (node?.role === "file-upload") {
          record.pendingFileUpload = { snapshotId, ref, generation };
          return {
            ok: true,
            action: "clicked",
            tabId,
            url: record.info.url,
            generation: record.info.generation,
          };
        }
        await abortableDelay(CLICK_NAVIGATION_DETECTION_MS, signal);
        const observation = capture.observation;
        if (!observation) {
          return {
            ok: true,
            action: "clicked",
            tabId,
            url: record.info.url,
            generation: record.info.generation,
          };
        }
        if (observation.kind === "new-tab") {
          const navigation = await observation.result;
          return {
            ok: true,
            action: "clicked",
            tabId,
            url: record.info.url,
            generation: record.info.generation,
            navigation,
          };
        }
        await this.waitForLoad(record, this.options.getSettings().navigation.navigationTimeoutMs, signal);
        const failure = record.lastLoadFailure ? structuredClone(record.lastLoadFailure) : undefined;
        return {
          ok: true,
          action: "clicked",
          tabId,
          url: record.info.url,
          generation: record.info.generation,
          navigation: {
            kind: "same-tab",
            status: failure ? "failed" : "completed",
            tabId,
            url: failure?.url ?? record.info.url,
            generation: record.info.generation,
            ...(failure ? { error: failure } : {}),
          },
        };
      } finally {
        if (record.activeClickCapture === capture) record.activeClickCapture = undefined;
      }
    });
  }

  async type(
    tabId: string,
    sessionId: string,
    ref: string,
    snapshotId: string,
    generation: number,
    text: string,
    submit = false,
  ): Promise<"key-events" | "mixed-insert-text"> {
    if (typeof text !== "string" || text.length > 64 * 1024 || /\0/.test(text)) {
      throw new BrowserError("INVALID_BROWSER_REQUEST", "Browser text input is invalid");
    }
    const record = this.requireOwnedTab(tabId, sessionId);
    this.assertSnapshotRef(record, ref, snapshotId, generation);
    return this.runAction(record, sessionId, "interact", async (signal) => {
      if (submit) await this.approveSensitiveAction(record, "Submit a form after entering text");
      const frameContext = record.snapshot?.frames.get(ref);
      if (!frameContext) throw new BrowserError("STALE_ELEMENT_REF", "Browser frame is no longer available");
      const point = await frameContext.frame.executeJavaScript(elementPointScript(snapshotId, ref, true));
      if (!isPoint(point)) throw new BrowserError("STALE_ELEMENT_REF", "Browser element is no longer editable");
      point.x += frameContext.offsetX;
      point.y += frameContext.offsetY;
      record.syntheticInput += 1;
      const releaseInputFocus = this.cdp.acquire(record.info.id);
      let focusEmulationEnabled = false;
      let usedInsertText = false;
      try {
        await this.cdp.sendCommand(record.info.id, "Emulation.setFocusEmulationEnabled", { enabled: true });
        focusEmulationEnabled = true;
        record.view.webContents.focus();
        await this.sendMouseClick(record, point.x, point.y, "left", 1, signal, [], true);
        // Keep the renderer focused for the complete input sequence. A hidden
        // Electron view may not have native window focus under Linux/Xvfb, so
        // do not restore focus emulation between the click and text insertion.
        // Re-focus the exact frame element after the trusted click so CDP text
        // insertion also reaches out-of-process iframes deterministically.
        const focusedPoint = await frameContext.frame.executeJavaScript(elementPointScript(snapshotId, ref, true));
        if (!isPoint(focusedPoint)) {
          throw new BrowserError("STALE_ELEMENT_REF", "Browser element is no longer editable");
        }
        record.view.webContents.focus();
        const selectModifier: BrowserInputModifier = process.platform === "darwin" ? "meta" : "control";
        const selectModifiers = cdpModifierMask([selectModifier]);
        await this.cdp.sendCommand(record.info.id, "Input.dispatchKeyEvent", {
          type: "keyDown",
          key: "a",
          code: "KeyA",
          modifiers: selectModifiers,
          windowsVirtualKeyCode: 65,
          nativeVirtualKeyCode: 65,
        });
        await this.cdp.sendCommand(record.info.id, "Input.dispatchKeyEvent", {
          type: "keyUp",
          key: "a",
          code: "KeyA",
          modifiers: selectModifiers,
          windowsVirtualKeyCode: 65,
          nativeVirtualKeyCode: 65,
        });
        // Keep selection and character events ordered on the same CDP queue,
        // then round-trip through the target OOPIF before inserting text.
        await frameContext.frame.executeJavaScript("true");
        for (const character of [...text]) {
          if (signal.aborted) throw new BrowserError("USER_TOOK_CONTROL", "User took control of the Browser tab");
          if (/^[\x20-\x7e]$/.test(character)) {
            record.view.webContents.sendInputEvent({ type: "keyDown", keyCode: character });
            record.view.webContents.sendInputEvent({ type: "char", keyCode: character });
            record.view.webContents.sendInputEvent({ type: "keyUp", keyCode: character });
          } else {
            await this.cdp.sendCommand(record.info.id, "Input.dispatchKeyEvent", {
              type: "char",
              key: character,
              text: character,
              unmodifiedText: character,
            });
            usedInsertText = true;
          }
          if (this.humanizedInputEnabled()) await abortableDelay(randomBetween(18, 64), signal);
        }
        if (submit) {
          record.view.webContents.sendInputEvent({ type: "keyDown", keyCode: "Enter" });
          record.view.webContents.sendInputEvent({ type: "char", keyCode: "Enter" });
          if (this.humanizedInputEnabled()) await abortableDelay(randomBetween(28, 85), signal);
          record.view.webContents.sendInputEvent({ type: "keyUp", keyCode: "Enter" });
        }
        return usedInsertText ? "mixed-insert-text" : "key-events";
      } finally {
        if (focusEmulationEnabled) {
          await this.cdp
            .sendCommand(record.info.id, "Emulation.setFocusEmulationEnabled", { enabled: false })
            .catch(() => undefined);
        }
        releaseInputFocus();
        record.syntheticInput -= 1;
      }
    });
  }

  async clickAt(
    tabId: string,
    sessionId: string,
    x: number,
    y: number,
    button: "left" | "middle" | "right" = "left",
    clickCount: 1 | 2 = 1,
    modifiers: BrowserInputModifier[] = [],
  ): Promise<BrowserClickResult> {
    modifiers = validateInputModifiers(modifiers);
    const record = this.requireOwnedTab(tabId, sessionId);
    if (
      ![x, y].every(Number.isFinite) ||
      !["left", "middle", "right"].includes(button) ||
      (clickCount !== 1 && clickCount !== 2)
    ) {
      throw new BrowserError("INVALID_BROWSER_REQUEST", "Browser click coordinates are invalid");
    }
    return this.runAction(record, sessionId, "interact", async (signal) => {
      const viewport = (await record.view.webContents.executeJavaScriptInIsolatedWorld(SNAPSHOT_WORLD_ID, [
        {
          code: `({ width: Math.max(0, innerWidth), height: Math.max(0, innerHeight), sensitive: (() => {
            const e = document.elementFromPoint(${Math.round(x)}, ${Math.round(y)});
            const text = (e?.getAttribute?.('aria-label') || e?.innerText || e?.getAttribute?.('name') || '').slice(0, 200);
            return /\\b(?:buy|purchase|pay|checkout|delete|remove|send|submit|authorize|approve|confirm|download|upload|sign[ -]?in|log[ -]?in)\\b/i.test(text);
          })() })`,
        },
      ])) as { width?: unknown; height?: unknown; sensitive?: unknown };
      const width = Number(viewport.width);
      const height = Number(viewport.height);
      if (x < 0 || y < 0 || x >= width || y >= height) {
        throw new BrowserError("INVALID_BROWSER_REQUEST", "Browser click coordinates are outside the viewport");
      }
      if (viewport.sensitive === true)
        await this.approveSensitiveAction(record, "Coordinate click on a sensitive control");
      record.syntheticInput += 1;
      try {
        await this.sendMouseClick(record, Math.round(x), Math.round(y), button, clickCount, signal, modifiers);
      } finally {
        record.syntheticInput -= 1;
      }
      return {
        ok: true,
        action: "clicked",
        tabId,
        url: record.info.url,
        generation: record.info.generation,
      };
    });
  }

  async press(tabId: string, sessionId: string, key: string, modifiers: BrowserInputModifier[] = []): Promise<void> {
    modifiers = validateInputModifiers(modifiers);
    if (typeof key !== "string" || !KEY_PATTERN.test(key)) {
      throw new BrowserError("INVALID_BROWSER_REQUEST", "Browser key is not allowed");
    }
    const record = this.requireOwnedTab(tabId, sessionId);
    await this.runAction(record, sessionId, "interact", async () => {
      record.syntheticInput += 1;
      try {
        record.view.webContents.focus();
        record.view.webContents.sendInputEvent({ type: "keyDown", keyCode: key, modifiers });
        if (key.length === 1 && !modifiers.some((modifier) => modifier !== "shift")) {
          record.view.webContents.sendInputEvent({ type: "char", keyCode: key, modifiers });
        }
        record.view.webContents.sendInputEvent({ type: "keyUp", keyCode: key, modifiers });
      } finally {
        record.syntheticInput -= 1;
      }
    });
  }

  async scroll(
    tabId: string,
    sessionId: string,
    input: { deltaX?: number; deltaY: number; x?: number; y?: number },
  ): Promise<void> {
    const deltaX = clampInteger(input.deltaX ?? 0, -100_000, 100_000);
    const deltaY = clampInteger(input.deltaY, -100_000, 100_000);
    if (deltaX === 0 && deltaY === 0) {
      throw new BrowserError("INVALID_BROWSER_REQUEST", "Browser scroll delta is empty");
    }
    const record = this.requireOwnedTab(tabId, sessionId);
    await this.runAction(record, sessionId, "interact", async (signal) => {
      const viewport = (await record.view.webContents.executeJavaScriptInIsolatedWorld(SNAPSHOT_WORLD_ID, [
        { code: `({ width: Math.max(1, innerWidth), height: Math.max(1, innerHeight) })` },
      ])) as { width?: unknown; height?: unknown };
      const x = clampInteger(input.x ?? Number(viewport.width) / 2, 0, Math.max(0, Number(viewport.width) - 1));
      const y = clampInteger(input.y ?? Number(viewport.height) / 2, 0, Math.max(0, Number(viewport.height) - 1));
      const segments = this.humanizedInputEnabled()
        ? clampInteger(Math.max(Math.abs(deltaX), Math.abs(deltaY)) / 180, 2, 12)
        : 1;
      const releaseScrollFocus = this.cdp.acquire(record.info.id);
      let focusEmulationEnabled = false;
      try {
        await this.cdp.sendCommand(record.info.id, "Emulation.setFocusEmulationEnabled", { enabled: true });
        focusEmulationEnabled = true;
        record.syntheticInput += 1;
        try {
          record.view.webContents.focus();
          for (let index = 0; index < segments; index += 1) {
            record.view.webContents.sendInputEvent({
              type: "mouseWheel",
              x,
              y,
              deltaX: Math.round(deltaX / segments),
              deltaY: Math.round(deltaY / segments),
              canScroll: true,
            });
            if (segments > 1) await abortableDelay(randomBetween(12, 38), signal);
          }
          await abortableDelay(32, signal);
        } finally {
          record.syntheticInput -= 1;
        }
      } finally {
        if (focusEmulationEnabled) {
          await this.cdp
            .sendCommand(record.info.id, "Emulation.setFocusEmulationEnabled", { enabled: false })
            .catch(() => undefined);
        }
        releaseScrollFocus();
      }
    });
  }

  async wait(
    tabId: string,
    sessionId: string,
    input: { timeoutMs?: number; condition?: "load" | "network-idle" | "selector" | "text"; value?: string },
  ): Promise<number> {
    const record = this.requireOwnedTab(tabId, sessionId);
    const timeout = clampInteger(input.timeoutMs ?? this.options.getSettings().navigation.actionTimeoutMs, 50, 120_000);
    const started = Date.now();
    await this.runAction(record, sessionId, "read", async (signal) => {
      if (!input.condition || input.condition === "load" || input.condition === "network-idle") {
        await this.waitForLoad(record, timeout, signal);
        if (input.condition === "network-idle") await abortableDelay(300, signal);
        return;
      }
      if (typeof input.value !== "string" || !input.value || input.value.length > 4_096) {
        throw new BrowserError("INVALID_BROWSER_REQUEST", "Browser wait value is invalid");
      }
      const deadline = Date.now() + timeout;
      while (Date.now() < deadline) {
        if (signal.aborted) throw new BrowserError("USER_TOOK_CONTROL", "User took control of the Browser tab");
        const code =
          input.condition === "selector"
            ? `Boolean(document.querySelector(${JSON.stringify(input.value)}))`
            : `(document.body?.innerText || "").includes(${JSON.stringify(input.value)})`;
        if (await record.view.webContents.executeJavaScriptInIsolatedWorld(SNAPSHOT_WORLD_ID, [{ code }])) return;
        await abortableDelay(100, signal);
      }
      throw new BrowserError("ACTION_TIMEOUT", "Browser wait timed out", { retryable: true });
    });
    return Date.now() - started;
  }

  async executeJavaScript(
    tabId: string,
    sessionId: string,
    source: string,
    options: {
      timeoutMs?: number;
      world?: "main" | "isolated";
      awaitPromise?: boolean;
      returnByValue?: boolean;
    } = {},
  ): Promise<{ value?: unknown; exception?: string; untrustedWebContent: true }> {
    if (typeof source !== "string" || !source || Buffer.byteLength(source) > MAX_SCRIPT_BYTES) {
      throw new BrowserError("INVALID_BROWSER_REQUEST", "Browser JavaScript source is invalid");
    }
    const record = this.requireOwnedTab(tabId, sessionId);
    await record.advancedReady;
    return this.runAction(record, sessionId, "advanced", async (signal) => {
      const contents = record.view.webContents;
      const releaseDebugger = this.cdp.acquire(record.info.id);
      let remoteObjectId: string | undefined;
      let terminateExecution = false;
      try {
        let contextId: number | undefined;
        if (options.world === "isolated") {
          const tree = await this.cdp.sendCommand<{
            frameTree?: { frame?: { id?: string } };
          }>(record.info.id, "Page.getFrameTree");
          const frameId = tree.frameTree?.frame?.id;
          if (!frameId) throw new BrowserError("JAVASCRIPT_TIMEOUT", "Browser main frame is unavailable");
          const isolated = await this.cdp.sendCommand<{ executionContextId?: number }>(
            record.info.id,
            "Page.createIsolatedWorld",
            {
              frameId,
              worldName: "pi-browser-tools",
              grantUniveralAccess: false,
            },
          );
          contextId = isolated.executionContextId;
        }
        const evaluated = (await withTimeout(
          this.cdp.sendCommand(record.info.id, "Runtime.evaluate", {
            expression: source,
            awaitPromise: options.awaitPromise !== false,
            returnByValue: options.returnByValue !== false,
            userGesture: true,
            ...(contextId === undefined ? {} : { contextId }),
          }),
          clampInteger(options.timeoutMs ?? this.options.getSettings().navigation.actionTimeoutMs, 50, 120_000),
          "JAVASCRIPT_TIMEOUT",
          signal,
        )) as {
          result?: {
            value?: unknown;
            objectId?: string;
            type?: string;
            subtype?: string;
            description?: string;
            unserializableValue?: string;
          };
          exceptionDetails?: { text?: string; exception?: { description?: string } };
        };
        remoteObjectId = evaluated.result?.objectId;
        if (evaluated.exceptionDetails) {
          const exception = redactBrowserText(
            evaluated.exceptionDetails.exception?.description ??
              evaluated.exceptionDetails.text ??
              "JavaScript execution failed",
            4_096,
          );
          throw new BrowserError("JAVASCRIPT_EXECUTION_FAILED", `Browser JavaScript failed: ${exception}`, {
            details: { exception },
          });
        }
        const value =
          options.returnByValue === false
            ? {
                type: evaluated.result?.type,
                subtype: evaluated.result?.subtype,
                description: evaluated.result?.description,
                unserializableValue: evaluated.result?.unserializableValue,
              }
            : evaluated.result?.value;
        const serialized = JSON.stringify(value);
        if (serialized && Buffer.byteLength(serialized) > MAX_SCRIPT_RESULT_BYTES) {
          throw new BrowserError("RESULT_TOO_LARGE", "Browser JavaScript result is too large");
        }
        return { value: sanitizeSerializable(value), untrustedWebContent: true };
      } catch (error) {
        if (error instanceof BrowserError) {
          terminateExecution = error.code === "JAVASCRIPT_TIMEOUT" || error.code === "USER_TOOK_CONTROL";
          throw error;
        }
        const exception = redactBrowserText(
          error instanceof Error ? error.message : "JavaScript execution failed",
          4_096,
        );
        throw new BrowserError("JAVASCRIPT_EXECUTION_FAILED", `Browser JavaScript failed: ${exception}`, {
          details: { exception },
          cause: error,
        });
      } finally {
        if (!contents.isDestroyed() && remoteObjectId && this.cdp.isAttached(record.info.id)) {
          await this.cdp
            .sendCommand(record.info.id, "Runtime.releaseObject", { objectId: remoteObjectId })
            .catch(() => undefined);
        }
        if (!contents.isDestroyed() && (terminateExecution || signal.aborted) && this.cdp.isAttached(record.info.id)) {
          await withTimeout(
            this.cdp.sendCommand(record.info.id, "Runtime.terminateExecution"),
            1_000,
            "JAVASCRIPT_TIMEOUT",
          ).catch(() => undefined);
        }
        releaseDebugger();
      }
    });
  }

  async sendCdpCommand(
    tabId: string,
    sessionId: string,
    method: string,
    params?: Record<string, unknown>,
  ): Promise<unknown> {
    const encodedParams = JSON.stringify(params ?? {});
    if (Buffer.byteLength(encodedParams) > MAX_SCRIPT_BYTES) {
      throw new BrowserError("RESULT_TOO_LARGE", "CDP command parameters are too large");
    }
    const record = this.requireOwnedTab(tabId, sessionId);
    await record.advancedReady;
    return this.runAction(record, sessionId, "advanced", async () => {
      const releaseDebugger = this.cdp.acquire(record.info.id, "raw-cdp");
      try {
        const result = await this.cdp.sendCommand(record.info.id, method, params);
        const encoded = JSON.stringify(result);
        const objectIds = collectRemoteObjectIds(result);
        for (const objectId of objectIds) {
          await this.cdp.sendCommand(record.info.id, "Runtime.releaseObject", { objectId }).catch(() => undefined);
        }
        if (encoded && Buffer.byteLength(encoded) > MAX_SCRIPT_RESULT_BYTES) {
          throw new BrowserError("RESULT_TOO_LARGE", "CDP command result is too large");
        }
        return encoded
          ? (JSON.parse(encoded, (key, value) => (key === "objectId" ? "<released>" : value)) as unknown)
          : undefined;
      } finally {
        releaseDebugger();
      }
    });
  }

  async networkList(
    tabId: string,
    sessionId: string,
    input: {
      after?: string;
      resourceTypes?: string[];
      urlPattern?: string;
      status?: number;
      limit?: number;
    },
  ): Promise<BrowserNetworkPage> {
    const record = this.requireOwnedTab(tabId, sessionId);
    await record.advancedReady;
    const recorder = this.requireNetworkRecorder(record);
    recorder.armBodyCapture();
    return recorder.list(input);
  }

  async networkSummary(
    tabId: string,
    sessionId: string,
    input: { failureLimit?: number; recentLimit?: number } = {},
  ): Promise<BrowserNetworkSummary> {
    const record = this.requireOwnedTab(tabId, sessionId);
    await record.advancedReady;
    const recorder = this.requireNetworkRecorder(record);
    recorder.armBodyCapture();
    return recorder.summary(input);
  }

  async consoleList(
    tabId: string,
    sessionId: string,
    input: { after?: string; levels?: BrowserConsoleLevel[]; limit?: number },
  ): Promise<BrowserConsolePage> {
    const record = this.requireOwnedTab(tabId, sessionId);
    await record.advancedReady;
    return this.runAction(record, sessionId, "advanced", async () => this.requireConsoleBuffer(record).list(input));
  }

  async consoleWait(
    tabId: string,
    sessionId: string,
    input: { after?: string; levels?: BrowserConsoleLevel[]; timeoutMs?: number },
  ): Promise<BrowserConsoleEntry> {
    const record = this.requireOwnedTab(tabId, sessionId);
    await record.advancedReady;
    return this.runAction(record, sessionId, "advanced", (signal) =>
      this.requireConsoleBuffer(record).wait(input, signal),
    );
  }

  async visualCompare(
    sessionId: string,
    input: {
      left: BrowserVisualCompareTarget;
      right: BrowserVisualCompareTarget;
      mode?: BrowserScreenshotMode;
      threshold?: number;
      includeDiff?: boolean;
    },
  ): Promise<BrowserVisualCompareResult> {
    const mode = input.mode ?? "viewport";
    const threshold = clampInteger(input.threshold ?? 16, 0, 255);
    const leftRecord = this.requireOwnedTab(input.left.tabId, sessionId);
    const rightRecord = this.requireOwnedTab(input.right.tabId, sessionId);
    const optionsFor = (target: BrowserVisualCompareTarget): BrowserScreenshotOptions => ({
      mode,
      format: "png",
      ...(mode === "element"
        ? {
            snapshotId: target.snapshotId,
            ref: target.ref,
            generation: target.generation,
          }
        : {}),
    });
    let left: BrowserScreenshotResult;
    let right: BrowserScreenshotResult;
    try {
      left = await this.screenshot(leftRecord.info.id, sessionId, optionsFor(input.left));
      right = await this.screenshot(rightRecord.info.id, sessionId, optionsFor(input.right));
    } catch (error) {
      if (
        error instanceof BrowserError &&
        ["STALE_ELEMENT_REF", "TAB_NOT_FOUND", "TAB_NOT_OWNED", "INSPECTION_STALE"].includes(error.code)
      ) {
        throw error;
      }
      throw new BrowserError("VISUAL_COMPARE_UNAVAILABLE", "Browser visual comparison capture is unavailable", {
        details: {
          causeCode: error instanceof BrowserError ? error.code : "UNKNOWN",
        },
        cause: error,
      });
    }
    if (leftRecord.info.generation !== left.generation || rightRecord.info.generation !== right.generation) {
      throw new BrowserError("VISUAL_COMPARE_UNAVAILABLE", "Browser page changed during visual comparison");
    }
    return compareScreenshots(left, right, threshold, input.includeDiff === true);
  }

  async networkWait(
    tabId: string,
    sessionId: string,
    input: { urlPattern?: string; resourceType?: string; timeoutMs?: number },
  ): Promise<BrowserNetworkRequest> {
    const record = this.requireOwnedTab(tabId, sessionId);
    await record.advancedReady;
    const recorder = this.requireNetworkRecorder(record);
    recorder.armBodyCapture();
    return this.runAction(record, sessionId, "advanced", (signal) => recorder.wait(input, signal));
  }

  async networkBody(
    tabId: string,
    sessionId: string,
    requestId: string,
    input: { full?: boolean; offset?: number; maxBytes?: number },
  ): Promise<BrowserNetworkBodyResult> {
    const record = this.requireOwnedTab(tabId, sessionId);
    await record.advancedReady;
    return this.runAction(record, sessionId, "advanced", async (signal) => {
      const recorder = this.requireNetworkRecorder(record);
      recorder.armBodyCapture();
      try {
        return await recorder.body(requestId, input);
      } catch (error) {
        const request = recorder.getRequest(requestId);
        if (!(error instanceof BrowserError) || request.method !== "GET") throw error;
        const sealed = recorder.getSealedReplayRecord(requestId);
        const checked = await this.getNetworkPolicy(record).check(sealed.url, {
          settings: this.options.getSettings().navigation,
          allowAboutBlank: false,
          userApprovedPrivateNetwork: false,
        });
        return runBoundedNetworkAction(
          signal,
          this.options.getSettings().navigation.actionTimeoutMs,
          async (networkSignal) => {
            const response = await record.session.fetch(checked.url, {
              method: "GET",
              headers: replayHeaders(sealed.headers),
              redirect: "error",
              signal: networkSignal,
            });
            const data = await readBoundedResponseBody(response, MAX_REPLAY_RESPONSE_BYTES, networkSignal);
            const mimeType = response.headers.get("content-type") ?? request.mimeType ?? "application/octet-stream";
            return recorder.recordRefetchedBody(requestId, data, mimeType);
          },
        );
      }
    });
  }

  async networkReplay(
    tabId: string,
    sessionId: string,
    requestId: string,
    overrides: { url?: string; headers?: Record<string, string>; body?: string } | undefined,
    reason: string,
  ): Promise<BrowserNetworkReplayResult> {
    if (typeof reason !== "string" || !reason.trim() || reason.length > 512 || /[\0\r\n]/.test(reason)) {
      throw new BrowserError("INVALID_BROWSER_REQUEST", "A concise request replay reason is required");
    }
    const record = this.requireOwnedTab(tabId, sessionId);
    await record.advancedReady;
    return this.runAction(record, sessionId, "advanced", async (signal) => {
      const recorder = this.requireNetworkRecorder(record);
      recorder.armBodyCapture();
      const sealed = recorder.getSealedReplayRecord(requestId);
      const method = sealed.method.toUpperCase();
      if (!["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"].includes(method)) {
        throw new BrowserError("REQUEST_REPLAY_BLOCKED", `Browser request method cannot be replayed: ${method}`);
      }
      const targetUrl = validateReplayUrl(overrides?.url ?? sealed.url);
      const checked = await this.getNetworkPolicy(record).check(targetUrl, {
        settings: this.options.getSettings().navigation,
        allowAboutBlank: false,
        userApprovedPrivateNetwork: false,
      });
      const headers = { ...replayHeaders(sealed.headers), ...validateReplayOverrides(overrides?.headers) };
      const body = overrides?.body ?? sealed.postData;
      if (body !== undefined && Buffer.byteLength(body) > 8 * 1024 * 1024) {
        throw new BrowserError("RESULT_TOO_LARGE", "Browser request replay body is too large");
      }
      if (!["GET", "HEAD"].includes(method)) {
        await this.approveSensitiveAction(
          record,
          `Replay ${method} to ${new URL(checked.url).origin} (${headers["content-type"] ?? "unknown content type"}, ${Buffer.byteLength(body ?? "")} bytes): ${reason.trim()}`,
        );
      }
      return runBoundedNetworkAction(
        signal,
        this.options.getSettings().navigation.actionTimeoutMs,
        async (networkSignal) => {
          let url = checked.url;
          let response: Response | undefined;
          for (let redirectCount = 0; redirectCount < 6; redirectCount += 1) {
            try {
              response = await record.session.fetch(url, {
                method,
                headers,
                ...(body === undefined || method === "GET" || method === "HEAD" ? {} : { body }),
                redirect: "manual",
                signal: networkSignal,
              });
            } catch (error) {
              if (/redirect.*(?:cancel|block)/i.test(error instanceof Error ? error.message : String(error))) {
                throw new BrowserError("REQUEST_REPLAY_BLOCKED", "Browser request replay redirect was blocked");
              }
              throw new BrowserError("REQUEST_REPLAY_NOT_AVAILABLE", "Browser request replay failed", {
                retryable: false,
                cause: error,
              });
            }
            const location = response.headers.get("location");
            if (!location || response.status < 300 || response.status >= 400) break;
            const next = new URL(location, url);
            if (next.origin !== new URL(url).origin) {
              throw new BrowserError("REQUEST_REPLAY_BLOCKED", "Cross-origin request replay redirect was blocked");
            }
            if (method !== "GET" && method !== "HEAD") break;
            url = (
              await this.getNetworkPolicy(record).check(next.toString(), {
                settings: this.options.getSettings().navigation,
                allowAboutBlank: false,
                userApprovedPrivateNetwork: false,
              })
            ).url;
          }
          if (!response) throw new BrowserError("REQUEST_REPLAY_NOT_AVAILABLE", "Browser request replay failed");
          const responseData = await readBoundedResponseBody(response, MAX_REPLAY_RESPONSE_BYTES, networkSignal);
          const responseHeaders = Object.fromEntries(response.headers.entries());
          const mimeType = response.headers.get("content-type") ?? "application/octet-stream";
          const replayed = recorder.recordReplay({
            replayedFrom: requestId,
            method,
            url,
            requestHeaders: headers,
            status: response.status,
            statusText: response.statusText,
            responseHeaders,
            body: responseData,
            mimeType,
          });
          return {
            request: replayed,
            ...(responseData.byteLength
              ? { responseBody: await recorder.body(replayed.requestId, { maxBytes: 512 * 1024 }) }
              : {}),
          };
        },
      );
    });
  }

  async chooseUploadFiles(tabId: string, paths: string[]): Promise<void> {
    const record = this.requireTab(tabId);
    if (
      !paths.length ||
      paths.length > 20 ||
      paths.some((entry) => typeof entry !== "string" || entry.length > 4_096)
    ) {
      throw new BrowserError("UPLOAD_DENIED", "No approved upload files were selected");
    }
    const releaseDebugger = this.cdp.acquire(record.info.id);
    try {
      const pending = record.pendingFileUpload;
      const hasPendingTarget = Boolean(
        pending &&
        pending.generation === record.info.generation &&
        record.snapshot?.id === pending.snapshotId &&
        record.snapshot.refs.has(pending.ref),
      );
      const document = await this.cdp.sendCommand<{
        root?: { nodeId?: number };
      }>(record.info.id, "DOM.getDocument", {
        depth: -1,
        pierce: true,
      });
      let result = await this.cdp.sendCommand<{ nodeId?: number }>(record.info.id, "DOM.querySelector", {
        nodeId: document.root?.nodeId,
        selector:
          hasPendingTarget && pending
            ? `input[type="file"][data-pi-browser-ref="${pending.snapshotId}:${pending.ref}"]`
            : 'input[type="file"]:focus',
      });
      // Local users can focus an upload input without an Agent snapshot.
      if (!result.nodeId && hasPendingTarget) {
        result = await this.cdp.sendCommand<{ nodeId?: number }>(record.info.id, "DOM.querySelector", {
          nodeId: document.root?.nodeId,
          selector: 'input[type="file"]:focus',
        });
      }
      if (!result.nodeId) throw new BrowserError("UPLOAD_DENIED", "Focus a file input before choosing upload files");
      await this.cdp.sendCommand(record.info.id, "DOM.setFileInputFiles", {
        files: paths,
        nodeId: result.nodeId,
      });
    } finally {
      record.pendingFileUpload = undefined;
      releaseDebugger();
    }
  }

  close(tabId: string, sessionId?: string): void {
    const record = this.tabs.get(tabId);
    if (!record) throw new BrowserError("TAB_NOT_FOUND", "Browser tab was not found");
    if (sessionId && record.info.ownerSessionId !== sessionId) {
      throw new BrowserError("TAB_NOT_OWNED", "Browser tab belongs to another session");
    }
    this.tabs.delete(tabId);
    this.cancelAgentActions(record, "TAB_NOT_FOUND", "Browser tab was closed");
    const win = this.options.getWindow();
    if (win && !win.isDestroyed()) {
      try {
        win.contentView.removeChildView(record.view);
      } catch {
        // The View may already have been detached with its parent window.
      }
    }
    this.inspections.clearTab(tabId);
    void record.consoleBuffer?.stop();
    void record.networkRecorder?.stop();
    this.cdp.disposeTab(tabId);
    const contents = record.view.webContents as WebContents | undefined;
    if (contents && !contents.isDestroyed()) contents.close();
    if (this.activeTabId === tabId) {
      this.activeTabId = this.tabs.keys().next().value ?? null;
      if (this.activeTabId) this.activate(this.activeTabId);
      else this.options.emit({ type: "active-tab-changed", tabId: null });
    }
    this.options.emit({ type: "tab-closed", tabId });
  }

  closeAll(options: { unsafeOnly?: boolean } = {}): void {
    for (const [tabId, record] of [...this.tabs]) {
      if (!options.unsafeOnly || this.options.profiles.get(record.info.profileId).mode === "unsafe") this.close(tabId);
    }
  }

  revokeAgentActions(sessionId?: string): void {
    for (const record of this.tabs.values()) {
      if (sessionId && record.info.ownerSessionId !== sessionId) continue;
      this.cancelAgentActions(record, "CAPABILITY_LEASE_EXPIRED", "Browser capability was revoked");
      this.setUserControl(record);
      this.emitUpdate(record);
    }
    if (sessionId) this.inspections.clearSession(sessionId);
    else this.inspections.clear();
  }

  clearSessionState(sessionId: string): void {
    this.inspections.clearSession(sessionId);
  }

  async clearAdvancedState(): Promise<void> {
    const cleanup: Promise<void>[] = [];
    for (const record of [...this.tabs.values()]) {
      record.info.advanced = false;
      const previous = record.advancedReady;
      const pending = previous
        .catch(() => undefined)
        .then(async () => {
          const contents = record.view.webContents as WebContents | undefined;
          await record.consoleBuffer?.stop().catch(() => undefined);
          record.consoleBuffer = undefined;
          await record.networkRecorder?.stop().catch(() => undefined);
          record.networkRecorder = undefined;
          record.identityProfile = undefined;
          if (contents && !contents.isDestroyed()) {
            this.identity.clear(record.info.id, contents, record.session, record.nativeUserAgent);
          }
          this.cdp.clearKeeps(record.info.id);
        });
      record.advancedReady = pending;
      cleanup.push(pending);
      this.emitUpdate(record);
    }
    await Promise.all(cleanup);
  }

  countAttachedDebuggers(): number {
    return this.cdp.countAttached();
  }

  getRendererProcessIds(): number[] {
    return [
      ...new Set(
        [...this.tabs.values()]
          .map(({ view }) => {
            const contents = view.webContents as WebContents | undefined;
            return !contents || contents.isDestroyed() ? 0 : contents.getOSProcessId();
          })
          .filter((processId) => processId > 0),
      ),
    ];
  }

  async applyAdvancedMode(): Promise<void> {
    const pending: Promise<void>[] = [];
    for (const record of this.tabs.values()) {
      const previous = record.advancedReady;
      record.advancedReady = previous.catch(() => undefined).then(() => this.prepareAdvancedRecord(record));
      pending.push(record.advancedReady);
      this.emitUpdate(record);
    }
    await Promise.all(pending);
  }

  dispose(): void {
    if (this.disposed) return;
    this.closeAll();
    this.cdp.dispose();
    this.disposed = true;
    this.networkPolicies.clear();
    this.nativeSessionUserAgents.clear();
    this.inspections.clear();
  }

  private assertAvailable(): void {
    if (this.disposed) throw new BrowserError("BROWSER_DISABLED", "Browser service is shutting down");
  }

  private installTabListeners(record: TabRecord): void {
    const wc = record.view.webContents;
    wc.setWindowOpenHandler((details) => {
      if (/^https?:/i.test(details.url)) {
        const result = this.openManagedPopup(record, details);
        this.captureClickNavigation(record, { kind: "new-tab", result });
        void result;
      } else if (/^mailto:/i.test(details.url)) {
        void this.options.openExternal?.(details.url).catch(() => undefined);
      }
      return { action: "deny" };
    });
    wc.on("will-navigate", (event, url) => {
      if (/^(?:https?:|about:blank$)/i.test(url)) {
        record.networkRecorder?.armBodyCapture();
        return;
      }
      event.preventDefault();
      if (/^mailto:/i.test(url)) void this.options.openExternal?.(url).catch(() => undefined);
    });
    wc.on("did-start-navigation", (details) => {
      if (!details.isMainFrame) return;
      record.networkRecorder?.armBodyCapture();
      record.lastLoadFailure = undefined;
      record.pendingFileUpload = undefined;
      this.captureClickNavigation(record, { kind: "same-tab" });
      record.info.loading = true;
      record.snapshot = undefined;
      this.emitUpdate(record);
    });
    wc.on("did-navigate", (_event, url) => {
      record.info.url = redactUrlCredentials(url);
      record.info.generation += 1;
      record.info.crashed = false;
      record.snapshot = undefined;
      this.inspections.clearTab(record.info.id);
      this.refreshHistory(record);
      this.emitUpdate(record);
    });
    wc.on("did-navigate-in-page", (_event, url, isMainFrame) => {
      if (!isMainFrame) return;
      this.captureClickNavigation(record, { kind: "same-tab" });
      record.info.url = redactUrlCredentials(url);
      record.info.generation += 1;
      record.snapshot = undefined;
      this.inspections.clearTab(record.info.id);
      this.refreshHistory(record);
      this.emitUpdate(record);
    });
    wc.on("page-title-updated", (event, title) => {
      event.preventDefault();
      record.info.title = title.slice(0, 512) || "Untitled";
      this.emitUpdate(record);
    });
    wc.on("did-start-loading", () => {
      record.info.loading = true;
      this.emitUpdate(record);
    });
    wc.on("did-stop-loading", () => {
      record.info.loading = false;
      this.refreshHistory(record);
      this.emitUpdate(record);
    });
    wc.on("dom-ready", () => {
      void wc
        .executeJavaScriptInIsolatedWorld(SNAPSHOT_WORLD_ID, [
          { code: externalProtocolGuardScript(record.externalProtocolToken) },
        ])
        .catch(() => undefined);
    });
    wc.on("console-message", (details) => {
      const message = details.message;
      const prefix = `pi-browser-external:${record.externalProtocolToken}:`;
      if (!message.startsWith(prefix)) return;
      const url = message.slice(prefix.length);
      if (/^mailto:/i.test(url)) void this.options.openExternal?.(url).catch(() => undefined);
    });
    wc.on("did-fail-load", (_event, errorCode, errorDescription, validatedUrl, isMainFrame) => {
      if (!isMainFrame || errorCode === -3) return;
      record.lastLoadFailure = {
        errorCode,
        errorDescription,
        url: redactUrlCredentials(validatedUrl || record.info.url),
      };
      record.info.loading = false;
      if (!record.info.title || record.info.title === "New tab") {
        record.info.title = `Load failed: ${errorDescription}`.slice(0, 512);
      }
      this.emitUpdate(record);
    });
    wc.on("render-process-gone", (_event, details) => {
      record.info.crashed = true;
      record.info.loading = false;
      this.cancelAgentActions(record, "TAB_CRASHED", "Browser tab renderer crashed");
      this.emitUpdate(record);
      this.options.emit({ type: "render-process-gone", tabId: record.info.id, reason: details.reason });
    });
    wc.on("unresponsive", () => {
      record.info.loading = false;
      this.emitUpdate(record);
    });
    wc.on("before-input-event", (event, input) => {
      if (isBrowserDevToolsShortcut(input)) {
        event.preventDefault();
        return;
      }
      if (
        record.syntheticInput === 0 &&
        record.info.control === "agent" &&
        this.options.getSettings().automation.userTakeover === "wait"
      ) {
        event.preventDefault();
        return;
      }
      this.handleUserInput(record);
    });
    wc.on("before-mouse-event", (event, input) => {
      if (input.type !== "mouseDown" && input.type !== "mouseWheel") return;
      if (
        record.syntheticInput === 0 &&
        record.info.control === "agent" &&
        this.options.getSettings().automation.userTakeover === "wait"
      ) {
        event.preventDefault();
        return;
      }
      this.handleUserInput(record);
    });
  }

  private captureClickNavigation(record: TabRecord, observation: ClickNavigationObservation): void {
    const capture = record.activeClickCapture;
    if (!capture || capture.observation) return;
    capture.observation = observation;
  }

  private async openManagedPopup(
    opener: TabRecord,
    details: Electron.HandlerDetails,
  ): Promise<BrowserClickNavigationResult> {
    const requestedUrl = redactUrlCredentials(details.url);
    try {
      const tab = await this.create(
        {
          profileId: opener.info.profileId,
          ownerSessionId: opener.info.ownerSessionId,
          url: details.url,
          activate: details.disposition !== "background-tab",
        },
        popupLoadOptions(details),
      );
      const record = this.tabs.get(tab.id);
      const failure = record?.lastLoadFailure ? structuredClone(record.lastLoadFailure) : undefined;
      return {
        kind: "new-tab",
        status: failure ? "failed" : "completed",
        tabId: tab.id,
        url: failure?.url ?? tab.url,
        generation: tab.generation,
        ...(failure ? { error: failure } : {}),
      };
    } catch (error) {
      const navigationError = navigationFailureError(error);
      const errorCode =
        typeof navigationError.details?.netErrorCode === "number" ? navigationError.details.netErrorCode : undefined;
      const errorDescription =
        typeof navigationError.details?.netError === "string"
          ? navigationError.details.netError
          : navigationError.message;
      return {
        kind: "new-tab",
        status: "failed",
        url: requestedUrl,
        error: {
          ...(errorCode === undefined ? {} : { errorCode }),
          errorDescription: errorDescription.slice(0, 256),
          url: requestedUrl,
        },
      };
    }
  }

  private handleUserInput(record: TabRecord): void {
    if (record.syntheticInput > 0 || record.info.control === "user") return;
    record.pendingFileUpload = undefined;
    this.setUserControl(record);
    record.info.generation += 1;
    record.snapshot = undefined;
    this.inspections.clearTab(record.info.id);
    this.cancelAgentActions(record, "USER_TOOK_CONTROL", "User took control of the Browser tab");
    this.emitUpdate(record);
  }

  private cancelAgentActions(record: TabRecord, code: BrowserErrorCode, message: string): void {
    for (const abort of record.pendingActions.keys()) {
      record.pendingActions.set(abort, { code, message });
      abort.abort();
    }
  }

  private async approveSensitiveAction(record: TabRecord, description: string): Promise<void> {
    const policy = this.options.getSettings().automation.sensitiveActions;
    if (policy === "deny") throw new BrowserError("PERMISSION_DENIED", "Sensitive Browser action is denied");
    const controlGeneration = record.controlGeneration;
    record.info.control = "waiting-for-approval";
    this.emitUpdate(record);
    const accepted = await (this.options.confirmSensitiveAction?.(description) ?? Promise.resolve(false));
    if (!canResumeSensitiveAgentControl(controlGeneration, record.controlGeneration, record.info.control)) {
      throw new BrowserError("USER_TOOK_CONTROL", "User took control during sensitive Browser approval");
    }
    record.info.control = "agent";
    this.emitUpdate(record);
    if (!accepted) throw new BrowserError("PERMISSION_DENIED", "Sensitive Browser action was not approved");
  }

  private async prepareAdvancedRecord(record: TabRecord): Promise<void> {
    const settings = this.options.getSettings().advancedBrowserMode;
    const contents = record.view.webContents;
    if (!contents || contents.isDestroyed()) return;
    if (!settings.enabled) {
      await record.consoleBuffer?.stop().catch(() => undefined);
      record.consoleBuffer = undefined;
      await record.networkRecorder?.stop().catch(() => undefined);
      record.networkRecorder = undefined;
      record.identityProfile = undefined;
      this.identity.clear(record.info.id, contents, record.session, record.nativeUserAgent);
      return;
    }
    const profile = this.identity.buildProfile(settings, record.nativeUserAgent);
    await this.identity.apply(record.info.id, contents, record.session, profile);
    record.identityProfile = profile;
    if (!record.consoleBuffer) {
      record.consoleBuffer = new BrowserConsoleBuffer(record.info.id, this.cdp);
    }
    await record.consoleBuffer.start();
    if (!record.networkRecorder) {
      record.networkRecorder = new BrowserNetworkRecorder({
        tabId: record.info.id,
        cdp: this.cdp,
        bodyDirectory: path.join(this.options.networkBodyRoot, record.info.id),
        maxRequests: () => this.options.getSettings().advancedBrowserMode.maxRequestsPerTab,
        maxBodyBytes: () => this.options.getSettings().advancedBrowserMode.maxBodyBytesPerTab,
        bodyCaptureIdleMs: this.options.networkBodyCaptureIdleMs,
      });
    }
    await record.networkRecorder.start();
  }

  private requireNetworkRecorder(record: TabRecord): BrowserNetworkRecorder {
    if (!this.options.getSettings().advancedBrowserMode.enabled || !record.networkRecorder) {
      throw new BrowserError("ADVANCED_BROWSER_MODE_REQUIRED", "Advanced Browser Mode is required");
    }
    return record.networkRecorder;
  }

  private requireConsoleBuffer(record: TabRecord): BrowserConsoleBuffer {
    if (!this.options.getSettings().advancedBrowserMode.enabled || !record.consoleBuffer) {
      throw new BrowserError("ADVANCED_BROWSER_MODE_REQUIRED", "Advanced Browser Mode is required");
    }
    return record.consoleBuffer;
  }

  private humanizedInputEnabled(): boolean {
    return this.options.getSettings().advancedBrowserMode.enabled;
  }

  private async sendMouseClick(
    record: TabRecord,
    x: number,
    y: number,
    button: "left" | "middle" | "right",
    clickCount: 1 | 2,
    signal: AbortSignal,
    modifiers: BrowserInputModifier[] = [],
    preserveFocusEmulation = false,
  ): Promise<void> {
    record.view.webContents.focus();
    const releaseDebugger = this.cdp.acquire(record.info.id);
    const cdpModifiers = cdpModifierMask(modifiers);
    let focusEmulationEnabled = false;
    try {
      await this.cdp.sendCommand(record.info.id, "Emulation.setFocusEmulationEnabled", { enabled: true });
      focusEmulationEnabled = true;
      if (this.humanizedInputEnabled()) {
        const viewport = (await record.view.webContents.executeJavaScriptInIsolatedWorld(SNAPSHOT_WORLD_ID, [
          { code: `({ x: Math.max(0, innerWidth / 2), y: Math.max(0, innerHeight / 2) })` },
        ])) as { x?: unknown; y?: unknown };
        const startX = Number(viewport.x) || x;
        const startY = Number(viewport.y) || y;
        const segments = randomBetween(3, 7);
        for (let index = 1; index <= segments; index += 1) {
          const progress = index / segments;
          await this.cdp.sendCommand(record.info.id, "Input.dispatchMouseEvent", {
            type: "mouseMoved",
            x: Math.round(startX + (x - startX) * progress),
            y: Math.round(startY + (y - startY) * progress),
            modifiers: cdpModifiers,
          });
          await abortableDelay(randomBetween(8, 24), signal);
        }
      } else {
        await this.cdp.sendCommand(record.info.id, "Input.dispatchMouseEvent", {
          type: "mouseMoved",
          x,
          y,
          modifiers: cdpModifiers,
        });
      }
      await this.cdp.sendCommand(record.info.id, "Input.dispatchMouseEvent", {
        type: "mousePressed",
        x,
        y,
        button,
        buttons: cdpButtonMask(button),
        clickCount,
        modifiers: cdpModifiers,
      });
      if (this.humanizedInputEnabled()) await abortableDelay(randomBetween(35, 105), signal);
      await this.cdp.sendCommand(record.info.id, "Input.dispatchMouseEvent", {
        type: "mouseReleased",
        x,
        y,
        button,
        buttons: 0,
        clickCount,
        modifiers: cdpModifiers,
      });
      // A CDP command acknowledgement only confirms that Chromium accepted the
      // input. Queue a no-op in the isolated world so non-navigation handlers
      // have run before the click result is returned to the next Agent tool.
      await record.view.webContents
        .executeJavaScriptInIsolatedWorld(SNAPSHOT_WORLD_ID, [{ code: "true" }])
        .catch(() => undefined);
      await abortableDelay(32, signal);
    } finally {
      if (focusEmulationEnabled && !preserveFocusEmulation) {
        await this.cdp
          .sendCommand(record.info.id, "Emulation.setFocusEmulationEnabled", { enabled: false })
          .catch(() => undefined);
      }
      releaseDebugger();
    }
  }

  private requireTab(tabId: string): TabRecord {
    if (typeof tabId !== "string") throw new BrowserError("INVALID_BROWSER_REQUEST", "Browser tab id is invalid");
    const record = this.tabs.get(tabId);
    if (!record) throw new BrowserError("TAB_NOT_FOUND", "Browser tab was not found");
    if (record.info.crashed)
      throw new BrowserError("TAB_CRASHED", "Browser tab renderer has crashed", { retryable: true });
    return record;
  }

  private requireOwnedTab(tabId: string, sessionId?: string): TabRecord {
    const record = this.requireTab(tabId);
    if (sessionId && record.info.ownerSessionId !== sessionId) {
      throw new BrowserError("TAB_NOT_OWNED", "Browser tab belongs to another session");
    }
    return record;
  }

  private resolveInspectionTab(tabId: string | undefined, sessionId: string): TabRecord {
    if (tabId) return this.requireOwnedTab(tabId, sessionId);
    if (this.activeTabId) {
      const active = this.tabs.get(this.activeTabId);
      if (active?.info.ownerSessionId === sessionId) return this.requireOwnedTab(active.info.id, sessionId);
    }
    const owned = [...this.tabs.values()].filter((record) => record.info.ownerSessionId === sessionId);
    if (owned.length === 1) return this.requireOwnedTab(owned[0]!.info.id, sessionId);
    throw new BrowserError("TAB_NOT_FOUND", "Specify an owned Browser tab before inspecting the page");
  }

  private async historyAction(
    tabId: string,
    sessionId: string | undefined,
    direction: "back" | "forward",
  ): Promise<BrowserTabInfo> {
    const record = this.requireOwnedTab(tabId, sessionId);
    const history = record.view.webContents.navigationHistory;
    if (direction === "back" ? history.canGoBack() : history.canGoForward()) {
      record.networkRecorder?.armBodyCapture();
      await this.runAction(record, sessionId, "read", async () => {
        if (direction === "back") history.goBack();
        else history.goForward();
        await this.waitForLoad(record, this.options.getSettings().navigation.navigationTimeoutMs);
      });
    }
    return structuredClone(record.info);
  }

  private async runAction<T>(
    record: TabRecord,
    sessionId: string | undefined,
    permission: "read" | "interact" | "advanced",
    task: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    void permission;
    if (!sessionId) {
      if (record.pendingActions.size > 0) {
        this.setUserControl(record);
        record.info.generation += 1;
        record.snapshot = undefined;
        this.cancelAgentActions(record, "USER_TOOK_CONTROL", "User took control of the Browser tab");
        this.emitUpdate(record);
      }
      return task(new AbortController().signal);
    }
    let resolveResult!: (value: T) => void;
    let rejectResult!: (reason: unknown) => void;
    const result = new Promise<T>((resolve, reject) => {
      resolveResult = resolve;
      rejectResult = reject;
    });
    const abort = new AbortController();
    record.pendingActions.set(abort, null);
    const run = async () => {
      const queuedCancellation = record.pendingActions.get(abort);
      if (abort.signal.aborted) {
        record.pendingActions.delete(abort);
        const cancellation = queuedCancellation ?? {
          code: "USER_TOOK_CONTROL" as const,
          message: "Browser action was cancelled",
        };
        rejectResult(new BrowserError(cancellation.code, cancellation.message));
        return;
      }
      record.activeAbort = abort;
      record.info.control = "agent";
      if (permission === "advanced") record.info.advanced = true;
      this.emitUpdate(record);
      this.options.emit({ type: "agent-action", tabId: record.info.id, state: "started" });
      try {
        const value = await task(abort.signal);
        if (abort.signal.aborted) throw new BrowserError("USER_TOOK_CONTROL", "User took control of the Browser tab");
        this.options.emit({ type: "agent-action", tabId: record.info.id, state: "finished" });
        resolveResult(value);
      } catch (error) {
        this.options.emit({ type: "agent-action", tabId: record.info.id, state: "failed" });
        const cancellation = record.pendingActions.get(abort);
        rejectResult(cancellation ? new BrowserError(cancellation.code, cancellation.message) : error);
      } finally {
        record.pendingActions.delete(abort);
        if (record.activeAbort === abort) record.activeAbort = undefined;
        this.setUserControl(record);
        record.info.advanced = false;
        this.emitUpdate(record);
      }
    };
    record.queue = record.queue.then(run, run);
    return result;
  }

  private setUserControl(record: TabRecord): void {
    if (record.info.control !== "user") record.controlGeneration += 1;
    record.info.control = "user";
  }

  private assertSnapshotRef(record: TabRecord, ref: string, snapshotId: string, generation: number): void {
    if (
      !record.snapshot ||
      record.snapshot.id !== snapshotId ||
      record.snapshot.generation !== generation ||
      record.info.generation !== generation ||
      !record.snapshot.refs.has(ref)
    ) {
      throw new BrowserError("STALE_ELEMENT_REF", "Browser element reference is stale; take a new snapshot");
    }
  }

  private async waitForLoad(record: TabRecord, timeout: number, signal?: AbortSignal): Promise<void> {
    if (!record.view.webContents.isLoading()) return;
    const webContents = record.view.webContents;
    let listener: (() => void) | undefined;
    await withTimeout(
      new Promise<void>((resolve) => {
        listener = () => resolve();
        webContents.once("did-stop-loading", listener);
      }),
      timeout,
      "ACTION_TIMEOUT",
      signal,
    ).finally(() => {
      if (listener && !webContents.isDestroyed()) webContents.removeListener("did-stop-loading", listener);
    });
  }

  private getNetworkPolicy(record: TabRecord): BrowserNetworkPolicy {
    let policy = this.networkPolicies.get(record.info.profileId);
    if (!policy) {
      policy = new BrowserNetworkPolicy(createSessionNetworkPolicyOptions(record.session));
      this.networkPolicies.set(record.info.profileId, policy);
    }
    return policy;
  }

  private refreshHistory(record: TabRecord): void {
    record.info.canGoBack = record.view.webContents.navigationHistory.canGoBack();
    record.info.canGoForward = record.view.webContents.navigationHistory.canGoForward();
  }

  private emitUpdate(record: TabRecord): void {
    this.options.emit({ type: "tab-updated", tab: structuredClone(record.info) });
  }
}

export function createSecureView(
  profile: BrowserProfileInfo,
  session: Session,
  advanced: BrowserAdvancedRuntimePolicy,
): WebContentsView {
  const advancedProfile = profile.mode === "unsafe" && advanced.enabled;
  return new WebContentsView({
    webPreferences: {
      session,
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: advancedProfile ? !advanced.disableWebSecurity : true,
      allowRunningInsecureContent: advancedProfile && advanced.allowInsecureContent,
      // Programmatic CDP is required for screenshots, uploads, and allowlisted
      // Advanced commands. No remote View receives a DevTools menu/bridge, and
      // common DevTools shortcuts are blocked in Main above.
      devTools: true,
      spellcheck: true,
      webviewTag: false,
      navigateOnDragDrop: false,
    },
  });
}

function tabSummary(tab: BrowserTabInfo): BrowserTabSummary {
  return {
    id: tab.id,
    profileId: tab.profileId,
    url: redactBrowserUrl(tab.url),
    title: tab.title.slice(0, 512),
    generation: tab.generation,
    loading: tab.loading,
    crashed: tab.crashed,
    visible: tab.visible,
  };
}

function boundInspectionSnapshot(
  record: TabRecord,
  snapshot: BrowserPageSnapshot,
  maxNodeChars: number,
): { snapshot: BrowserPageSnapshot; nodesTruncated: boolean } {
  const nodes: BrowserSnapshotNode[] = [];
  let usedChars = 0;
  for (const node of snapshot.nodes) {
    const bounded: BrowserSnapshotNode = {
      ...node,
      name: node.name.slice(0, 300),
      ...(node.value === undefined ? {} : { value: node.value.slice(0, 500) }),
      ...(node.description === undefined ? {} : { description: node.description.slice(0, 300) }),
      ...(node.frameUrl === undefined ? {} : { frameUrl: redactBrowserUrl(node.frameUrl, 2_048) }),
    };
    const size = JSON.stringify(bounded).length;
    if (usedChars + size > maxNodeChars) break;
    nodes.push(bounded);
    usedChars += size;
  }
  if (nodes.length !== snapshot.nodes.length && record.snapshot) {
    const refs = new Set(nodes.map((node) => node.ref));
    record.snapshot.refs = refs;
    record.snapshot.nodes = new Map([...record.snapshot.nodes].filter(([ref]) => refs.has(ref)));
    record.snapshot.frames = new Map([...record.snapshot.frames].filter(([ref]) => refs.has(ref)));
  }
  const nodesTruncated = nodes.length !== snapshot.nodes.length;
  return {
    snapshot: {
      ...snapshot,
      nodes,
      truncated: snapshot.truncated || nodesTruncated,
    },
    nodesTruncated,
  };
}

function screenshotRectForNode(
  node: BrowserSnapshotNode | undefined,
  maxPixels: number,
): { x: number; y: number; width: number; height: number } {
  if (!node?.bounds) throw new BrowserError("STALE_ELEMENT_REF", "Browser element has no current screenshot bounds");
  const x = Math.max(0, Math.floor(node.bounds.x));
  const y = Math.max(0, Math.floor(node.bounds.y));
  const width = Math.max(1, Math.ceil(node.bounds.width));
  const height = Math.max(1, Math.ceil(node.bounds.height));
  if (width * height > maxPixels) {
    throw new BrowserError("RESULT_TOO_LARGE", "Browser element screenshot exceeds the pixel limit");
  }
  return { x, y, width, height };
}

function compareScreenshots(
  left: BrowserScreenshotResult,
  right: BrowserScreenshotResult,
  threshold: number,
  includeDiff: boolean,
): BrowserVisualCompareResult {
  const leftImage = nativeImage.createFromBuffer(Buffer.from(left.base64, "base64"));
  const rightImage = nativeImage.createFromBuffer(Buffer.from(right.base64, "base64"));
  const leftSize = leftImage.getSize();
  const rightSize = rightImage.getSize();
  const dimensionsMatch = leftSize.width === rightSize.width && leftSize.height === rightSize.height;
  const width = Math.max(leftSize.width, rightSize.width);
  const height = Math.max(leftSize.height, rightSize.height);
  const totalPixels = width * height;
  if (totalPixels <= 0 || totalPixels > MAX_COMPARE_PIXELS) {
    throw new BrowserError("VISUAL_COMPARE_UNAVAILABLE", "Browser visual comparison exceeds the pixel limit");
  }
  if (!dimensionsMatch) {
    return {
      mode: left.mode,
      width,
      height,
      dimensionsMatch: false,
      differentPixels: totalPixels,
      totalPixels,
      differenceRatio: 1,
      regions: [{ x: 0, y: 0, width, height }],
      leftGeneration: left.generation,
      rightGeneration: right.generation,
      untrustedWebContent: true,
    };
  }
  const leftBitmap = leftImage.toBitmap();
  const rightBitmap = rightImage.toBitmap();
  if (leftBitmap.length !== rightBitmap.length || leftBitmap.length < totalPixels * 4) {
    throw new BrowserError("VISUAL_COMPARE_UNAVAILABLE", "Browser screenshot bitmap is unavailable");
  }
  const diffBitmap = includeDiff ? Buffer.alloc(leftBitmap.length) : undefined;
  let differentPixels = 0;
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  for (let pixel = 0; pixel < totalPixels; pixel += 1) {
    const offset = pixel * 4;
    let different = false;
    for (let channel = 0; channel < 4; channel += 1) {
      if (Math.abs(leftBitmap[offset + channel]! - rightBitmap[offset + channel]!) > threshold) {
        different = true;
        break;
      }
    }
    if (different) {
      differentPixels += 1;
      const x = pixel % width;
      const y = Math.floor(pixel / width);
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
      if (diffBitmap) {
        diffBitmap[offset] = 0;
        diffBitmap[offset + 1] = 0;
        diffBitmap[offset + 2] = 255;
        diffBitmap[offset + 3] = 255;
      }
    } else if (diffBitmap) {
      diffBitmap[offset] = Math.round(leftBitmap[offset]! * 0.25);
      diffBitmap[offset + 1] = Math.round(leftBitmap[offset + 1]! * 0.25);
      diffBitmap[offset + 2] = Math.round(leftBitmap[offset + 2]! * 0.25);
      diffBitmap[offset + 3] = 255;
    }
  }
  let diff: BrowserScreenshotResult | undefined;
  if (diffBitmap) {
    const png = nativeImage.createFromBitmap(diffBitmap, { width, height, scaleFactor: 1 }).toPNG();
    if (png.byteLength > MAX_SCREENSHOT_BYTES) {
      throw new BrowserError("RESULT_TOO_LARGE", "Browser visual diff exceeds the result size limit");
    }
    diff = {
      tabId: left.tabId,
      mime: "image/png",
      base64: png.toString("base64"),
      width,
      height,
      mode: left.mode,
      generation: left.generation,
      untrustedWebContent: true,
    };
  }
  return {
    mode: left.mode,
    width,
    height,
    dimensionsMatch: true,
    differentPixels,
    totalPixels,
    differenceRatio: differentPixels / totalPixels,
    regions: differentPixels === 0 ? [] : [{ x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 }],
    leftGeneration: left.generation,
    rightGeneration: right.generation,
    ...(diff ? { diff } : {}),
    untrustedWebContent: true,
  };
}

function normalizeAddress(value: string): string {
  if (typeof value !== "string") throw new BrowserError("INVALID_BROWSER_REQUEST", "Browser address is invalid");
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 8_192 || /[\0\r\n]/.test(trimmed)) {
    throw new BrowserError("INVALID_BROWSER_REQUEST", "Browser address is invalid");
  }
  if (trimmed === "about:blank" || /^[a-z][a-z0-9+.-]*:/i.test(trimmed)) return trimmed;
  return `https://${trimmed}`;
}

function navigationFailureError(error: unknown): BrowserError {
  if (error instanceof BrowserError && error.code === "NAVIGATION_FAILED") return error;
  const failure =
    error && typeof error === "object" && "errorDescription" in error ? (error as BrowserLoadFailure) : undefined;
  const source = error as { code?: unknown; errno?: unknown; message?: unknown };
  const netError =
    failure?.errorDescription ||
    (typeof source?.code === "string" ? source.code : "") ||
    (typeof source?.message === "string" ? source.message : "Navigation failed");
  const netErrorCode =
    failure?.errorCode ??
    (typeof source?.errno === "number" ? source.errno : typeof source?.code === "number" ? source.code : undefined);
  const permanentTls = /CERT_|SSL_|BLOCKED_BY_CLIENT|DISALLOWED_URL_SCHEME/i.test(netError);
  return new BrowserError("NAVIGATION_FAILED", "Browser navigation failed", {
    retryable: !permanentTls,
    recovery: permanentTls
      ? { reason: "unsupported", remediation: "ask-user" }
      : {
          reason: "transient-network",
          remediation: "wait-and-retry-once",
          retryAfterMs: 250,
        },
    details: {
      netError: netError.slice(0, 256),
      ...(netErrorCode === undefined ? {} : { netErrorCode }),
    },
    cause: error,
  });
}

function externalProtocolGuardScript(token: string): string {
  const prefix = `pi-browser-external:${token}:`;
  return `(() => {
    if (globalThis.__piExternalProtocolGuardInstalled) return;
    Object.defineProperty(globalThis, '__piExternalProtocolGuardInstalled', { value: true });
    document.addEventListener('click', (event) => {
      if (!event.isTrusted) return;
      const anchor = event.composedPath().find((node) => node && node.nodeType === 1 && node.tagName === 'A');
      if (!anchor) return;
      let url;
      try { url = new URL(anchor.href, location.href); } catch { return; }
      if (url.protocol === 'http:' || url.protocol === 'https:' || url.href === 'about:blank') return;
      event.preventDefault();
      event.stopImmediatePropagation();
      if (url.protocol === 'mailto:') console.info(${JSON.stringify(prefix)} + url.href.slice(0, 8192));
    }, true);
  })()`;
}

async function collectFrameContexts(
  contents: WebContents,
): Promise<Array<{ frame: WebFrameMain; offsetX: number; offsetY: number }>> {
  const result: Array<{ frame: WebFrameMain; offsetX: number; offsetY: number }> = [];
  const visit = async (frame: WebFrameMain, offsetX: number, offsetY: number): Promise<void> => {
    result.push({ frame, offsetX, offsetY });
    const children = frame.frames;
    if (!children.length) return;
    let rects: Array<{ x: number; y: number }> = [];
    try {
      const value =
        await frame.executeJavaScript(`Array.from(document.querySelectorAll('iframe,frame')).map((element) => {
        const rect = element.getBoundingClientRect();
        return { x: Math.round(rect.x), y: Math.round(rect.y) };
      })`);
      if (Array.isArray(value)) {
        rects = value.filter((entry): entry is { x: number; y: number } =>
          Boolean(
            entry &&
            typeof entry === "object" &&
            Number.isFinite((entry as { x?: unknown }).x) &&
            Number.isFinite((entry as { y?: unknown }).y),
          ),
        );
      }
    } catch {
      // A destroyed or provisional frame is omitted from the current snapshot.
    }
    for (const [index, child] of children.entries()) {
      const rect = rects[index] ?? { x: 0, y: 0 };
      await visit(child, offsetX + rect.x, offsetY + rect.y);
    }
  };
  await visit(contents.mainFrame, 0, 0);
  return result;
}

function createSnapshotScript(snapshotId: string, maxNodes: number, maxTextChars: number, startIndex = 0): string {
  return `(() => {
    const token = ${JSON.stringify(snapshotId)};
    for (const old of document.querySelectorAll('[data-pi-browser-ref]')) old.removeAttribute('data-pi-browser-ref');
    const selector = 'a,button,input,textarea,select,summary,[role],[tabindex],[contenteditable="true"]';
    const all = Array.from(document.querySelectorAll(selector));
    const nodes = [];
    let nodesTruncated = false;
    let index = ${startIndex};
    for (const element of all) {
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      if (rect.width <= 0 || rect.height <= 0 || style.visibility === 'hidden' || style.display === 'none') continue;
      if (nodes.length >= ${maxNodes}) {
        nodesTruncated = true;
        break;
      }
      const ref = 'e' + (++index);
      element.setAttribute('data-pi-browser-ref', token + ':' + ref);
      const tag = element.tagName.toLowerCase();
      const autocomplete = (element.getAttribute('autocomplete') || '').toLowerCase();
      const secretInput = tag === 'input' && (element.type === 'password' || /(?:password|one-time-code|cc-number|cc-csc)/.test(autocomplete));
      const safeValue = secretInput || (tag === 'input' && element.type === 'file') ? '' : (typeof element.value === 'string' ? element.value : '');
      const role = element.getAttribute('role') || ({a:'link',button:'button',input:(element.type === 'checkbox' ? 'checkbox' : element.type === 'radio' ? 'radio' : element.type === 'file' ? 'file-upload' : element.type === 'password' ? 'password' : 'textbox'),textarea:'textbox',select:'combobox',summary:'button'}[tag] || 'generic');
      const name = (element.getAttribute('aria-label') || element.getAttribute('alt') || element.getAttribute('placeholder') || element.innerText || safeValue || element.getAttribute('title') || '').trim().replace(/\\s+/g, ' ').slice(0, 500);
      nodes.push({ ref, role, name, value: secretInput ? undefined : safeValue.slice(0, 2000), description: secretInput ? 'Sensitive value redacted' : undefined, disabled: Boolean(element.disabled), focused: document.activeElement === element, checked: typeof element.checked === 'boolean' ? element.checked : undefined, level: Number(element.getAttribute('aria-level')) || undefined, bounds: { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) } });
    }
    const rawText = (document.body?.innerText || '').replace(/\\r/g, '');
    const textTruncated = rawText.length > ${maxTextChars};
    return { text: rawText.slice(0, ${maxTextChars}), nodes, textTruncated, nodesTruncated };
  })()`;
}

function elementPointScript(snapshotId: string, ref: string, focus: boolean): string {
  return `(() => {
    const element = document.querySelector('[data-pi-browser-ref=' + CSS.escape(${JSON.stringify(`${snapshotId}:${ref}`)}) + ']');
    if (!element || !element.isConnected) return null;
    let rect = element.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return null;
    if (rect.bottom <= 0 || rect.right <= 0 || rect.top >= innerHeight || rect.left >= innerWidth) {
      element.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
      rect = element.getBoundingClientRect();
    }
    const left = Math.max(0, rect.left);
    const right = Math.min(innerWidth, rect.right);
    const top = Math.max(0, rect.top);
    const bottom = Math.min(innerHeight, rect.bottom);
    if (right <= left || bottom <= top) return null;
    const x = Math.round(left + (right - left) / 2);
    const y = Math.round(top + (bottom - top) / 2);
    ${focus ? "element.focus(); if (element.matches?.('input:not([type=file]),textarea') && typeof element.select === 'function') element.select();" : ""}
    const anchor = element.closest?.('a[href]');
    let externalUrl;
    if (anchor) {
      try {
        const target = new URL(anchor.href, location.href);
        if (target.protocol !== 'http:' && target.protocol !== 'https:' && target.href !== 'about:blank') externalUrl = target.href.slice(0, 8192);
      } catch {}
    }
    return { x, y, externalUrl };
  })()`;
}

function popupLoadOptions(details: Electron.HandlerDetails): Electron.LoadURLOptions {
  const options: Electron.LoadURLOptions = {};
  if (details.referrer?.url) options.httpReferrer = details.referrer;
  if (details.postBody?.data?.length) {
    options.postData = details.postBody.data;
    const rawContentType = details.postBody.contentType;
    if (rawContentType && !/[\r\n]/.test(rawContentType)) {
      const boundary = details.postBody.boundary;
      const contentType =
        boundary && !/boundary=/i.test(rawContentType) && !/[\r\n]/.test(boundary)
          ? `${rawContentType}; boundary=${boundary}`
          : rawContentType;
      options.extraHeaders = `Content-Type: ${contentType}`;
    }
  }
  return options;
}

function elementHighlightScript(snapshotId: string, ref: string, show: boolean): string {
  const token = `${snapshotId}:${ref}`;
  return `(() => {
    const markerId = 'pi-browser-action-highlight';
    document.getElementById(markerId)?.remove();
    if (!${show}) return;
    const element = document.querySelector('[data-pi-browser-ref=' + CSS.escape(${JSON.stringify(token)}) + ']');
    if (!element || !element.isConnected) return;
    const rect = element.getBoundingClientRect();
    const marker = document.createElement('div');
    marker.id = markerId;
    marker.setAttribute('aria-hidden', 'true');
    Object.assign(marker.style, {
      position: 'fixed', pointerEvents: 'none', zIndex: '2147483647',
      left: Math.max(0, rect.left - 3) + 'px', top: Math.max(0, rect.top - 3) + 'px',
      width: Math.max(1, rect.width + 6) + 'px', height: Math.max(1, rect.height + 6) + 'px',
      border: '2px solid #f59e0b', borderRadius: '5px', boxSizing: 'border-box',
      background: 'rgba(245, 158, 11, 0.12)'
    });
    document.documentElement.appendChild(marker);
  })()`;
}

function isSensitiveNode(node: BrowserSnapshotNode): boolean {
  const text = `${node.role} ${node.name}`.toLowerCase();
  return /\b(?:buy|purchase|pay|checkout|delete|remove|send|submit|authorize|approve|confirm|download|upload|sign[ -]?in|log[ -]?in)\b/.test(
    text,
  );
}

function validateSnapshotResult(value: unknown): {
  text: string;
  nodes: BrowserSnapshotNode[];
  textTruncated: boolean;
  nodesTruncated: boolean;
} {
  if (!value || typeof value !== "object")
    throw new BrowserError("INVALID_BROWSER_REQUEST", "Invalid Browser snapshot result");
  const result = value as {
    text?: unknown;
    nodes?: unknown;
    textTruncated?: unknown;
    nodesTruncated?: unknown;
  };
  if (typeof result.text !== "string" || !Array.isArray(result.nodes)) {
    throw new BrowserError("INVALID_BROWSER_REQUEST", "Invalid Browser snapshot result");
  }
  const nodes = result.nodes.filter((node): node is BrowserSnapshotNode => {
    if (!node || typeof node !== "object") return false;
    const candidate = node as Partial<BrowserSnapshotNode>;
    return (
      typeof candidate.ref === "string" && typeof candidate.role === "string" && typeof candidate.name === "string"
    );
  });
  return {
    text: result.text,
    nodes,
    textTruncated: result.textTruncated === true,
    nodesTruncated: result.nodesTruncated === true,
  };
}

function isPoint(value: unknown): value is { x: number; y: number; externalUrl?: string } {
  return (
    !!value &&
    typeof value === "object" &&
    Number.isFinite((value as { x?: unknown }).x) &&
    Number.isFinite((value as { y?: unknown }).y)
  );
}

function clampInteger(value: number, minimum: number, maximum: number): number {
  if (!Number.isFinite(value)) return minimum;
  return Math.max(minimum, Math.min(maximum, Math.round(value)));
}

function randomBetween(minimum: number, maximum: number): number {
  return Math.floor(minimum + Math.random() * (maximum - minimum + 1));
}

function validateReplayUrl(value: string): string {
  if (typeof value !== "string" || !value || value.length > 8_192 || /[\0\r\n]/.test(value)) {
    throw new BrowserError("INVALID_BROWSER_REQUEST", "Browser request replay URL is invalid");
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new BrowserError("INVALID_BROWSER_REQUEST", "Browser request replay URL is invalid");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new BrowserError("REQUEST_REPLAY_BLOCKED", "Browser request replay protocol is blocked");
  }
  url.username = "";
  url.password = "";
  return url.toString();
}

function validateInputModifiers(value: BrowserInputModifier[]): BrowserInputModifier[] {
  if (!Array.isArray(value) || value.length > 4) {
    throw new BrowserError("INVALID_BROWSER_REQUEST", "Browser input modifiers are invalid");
  }
  const allowed = new Set<BrowserInputModifier>(["alt", "control", "meta", "shift"]);
  const result = [...new Set(value)];
  if (result.some((modifier) => !allowed.has(modifier))) {
    throw new BrowserError("INVALID_BROWSER_REQUEST", "Browser input modifiers are invalid");
  }
  return result;
}

function cdpModifierMask(modifiers: BrowserInputModifier[]): number {
  return modifiers.reduce((mask, modifier) => {
    if (modifier === "alt") return mask | 1;
    if (modifier === "control") return mask | 2;
    if (modifier === "meta") return mask | 4;
    return mask | 8;
  }, 0);
}

function cdpButtonMask(button: "left" | "middle" | "right"): number {
  if (button === "left") return 1;
  if (button === "right") return 2;
  return 4;
}

function replayHeaders(value: Record<string, string>): Record<string, string> {
  const blocked = new Set([
    "host",
    "cookie",
    "content-length",
    "proxy-authorization",
    "connection",
    "transfer-encoding",
  ]);
  const result: Record<string, string> = {};
  for (const [name, headerValue] of Object.entries(value)) {
    const normalized = name.trim().toLowerCase();
    if (!normalized || blocked.has(normalized) || normalized.startsWith("sec-")) continue;
    if (/[\0\r\n]/.test(name) || /[\0\r\n]/.test(headerValue)) continue;
    result[normalized] = headerValue.slice(0, 16_384);
  }
  return result;
}

function validateReplayOverrides(value?: Record<string, string>): Record<string, string> {
  if (!value) return {};
  if (Object.keys(value).length > 100) {
    throw new BrowserError("INVALID_BROWSER_REQUEST", "Too many Browser request replay header overrides");
  }
  const normalized = replayHeaders(value);
  if (Object.keys(normalized).length !== Object.keys(value).length) {
    throw new BrowserError("REQUEST_REPLAY_BLOCKED", "A protected Browser request header cannot be overridden");
  }
  return normalized;
}

function redactUrlCredentials(value: string): string {
  return redactBrowserUrl(value);
}

function sanitizeSerializable(value: unknown): unknown {
  if (value === undefined || value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : String(value);
  try {
    return JSON.parse(JSON.stringify(value)) as unknown;
  } catch {
    return String(value).slice(0, 4_096);
  }
}

function collectRemoteObjectIds(value: unknown): string[] {
  const objectIds = new Set<string>();
  const visit = (candidate: unknown, depth: number): void => {
    if (!candidate || typeof candidate !== "object" || depth > 32 || objectIds.size >= 1_000) return;
    if (Array.isArray(candidate)) {
      for (const entry of candidate) visit(entry, depth + 1);
      return;
    }
    for (const [key, entry] of Object.entries(candidate as Record<string, unknown>)) {
      if (key === "objectId" && typeof entry === "string" && entry.length <= 4_096) objectIds.add(entry);
      else visit(entry, depth + 1);
    }
  };
  visit(value, 0);
  return [...objectIds];
}

async function capturePresentedFrame(contents: WebContents, timeoutMs: number): Promise<Electron.NativeImage> {
  return new Promise<Electron.NativeImage>((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (!contents.isDestroyed()) {
        try {
          contents.endFrameSubscription();
        } catch {
          // The subscription may already have ended with the renderer.
        }
      }
      callback();
    };
    const timer = setTimeout(
      () => finish(() => reject(new BrowserError("ACTION_TIMEOUT", "Browser frame capture timed out"))),
      timeoutMs,
    );
    try {
      contents.beginFrameSubscription(false, (frame) => {
        if (!frame.isEmpty()) finish(() => resolve(frame));
      });
      contents.invalidate();
    } catch (error) {
      finish(() => reject(error));
    }
  });
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  code: "ACTION_TIMEOUT" | "JAVASCRIPT_TIMEOUT",
  signal?: AbortSignal,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      callback();
    };
    const onAbort = () =>
      finish(() => reject(new BrowserError("USER_TOOK_CONTROL", "User took control of the Browser tab")));
    const timer = setTimeout(
      () => finish(() => reject(new BrowserError(code, "Browser action timed out", { retryable: true }))),
      timeoutMs,
    );
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();
    promise.then(
      (value) => finish(() => resolve(value)),
      (error) => finish(() => reject(error)),
    );
  });
}

function abortableDelay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(new BrowserError("USER_TOOK_CONTROL", "User took control of the Browser tab"));
      },
      { once: true },
    );
  });
}
