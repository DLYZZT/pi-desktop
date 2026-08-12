import path from "node:path";
import { createHmac, randomBytes } from "node:crypto";
import { app, dialog, safeStorage, session, shell, type BrowserWindow, type Session } from "electron";
import type {
  BrowserCapabilitySnapshot,
  BrowserAgentAuthorizationDecision,
  BrowserConfirmationKind,
  BrowserConfirmationProof,
  BrowserCookiePage,
  BrowserCookieRecord,
  BrowserCreateProfileInput,
  BrowserCreateTabInput,
  BrowserDataType,
  BrowserDiagnostics,
  BrowserEvent,
  BrowserHeaderRule,
  BrowserHeaderRuleDirection,
  BrowserHostMethod,
  BrowserHostParams,
  BrowserHostResult,
  BrowserPermissionDecision,
  BrowserProfileInfo,
  BrowserPageSnippetSummary,
  BrowserProxyCredentialsInput,
  BrowserRendererState,
  BrowserPersistentSessionPermission,
  BrowserRuntimeSessionGrant,
  BrowserSessionGrantInput,
  BrowserSettingsPatch,
  BrowserSettingsPublic,
  BrowserTabInfo,
} from "../../contract/browser.ts";
import { isBrowserHostMethod } from "../../contract/browser.ts";
import { BrowserConfirmationManager } from "./browser-confirmation.ts";
import { BrowserAuthorizationCoordinator } from "./browser-authorization-coordinator.ts";
import { BrowserDownloadManager } from "./browser-download-manager.ts";
import { BrowserError, asBrowserError } from "./browser-error.ts";
import { BrowserHeaderRuleStore } from "./browser-header-rule-store.ts";
import { validateHeaderRules } from "./browser-header-rules.ts";
import { BrowserAgentHeaderRuleRegistry } from "./browser-agent-header-rule-registry.ts";
import { BrowserNetworkInterceptor } from "./browser-network-interceptor.ts";
import { BrowserPolicyEngine, createDisabledAdvancedRuntimePolicy } from "./browser-policy.ts";
import { BrowserPersistentGrantStore } from "./browser-persistent-grant-store.ts";
import { BrowserProfileManager, DEFAULT_BROWSER_PROFILE_ID } from "./browser-profile-manager.ts";
import { BrowserSecretVault, type BrowserSecretCodec } from "./browser-secret-vault.ts";
import { BrowserSettingsStore } from "./browser-settings-store.ts";
import { authorizeBrowserSettingsUpdate, prepareBrowserSettingsUpdate } from "./browser-settings-confirmation.ts";
import { BrowserSnippetStore } from "./browser-snippet-store.ts";
import { BrowserTabManager } from "./browser-tab-manager.ts";
import { BrowserTabRestoreStore } from "./browser-tab-restore-store.ts";
import { appendMainLog } from "../logger.ts";
import { countAdvancedProfileTabs, toBrowserRestoreRecords } from "./browser-tab-restoration.ts";

const RESTORE_DEBOUNCE_MS = 500;
const RUNTIME_GRANT_TTL_MS = 8 * 60 * 60 * 1_000;
type BrowserConfirmationLanguage = "en-US" | "zh-CN";

export interface BrowserServiceOptions {
  userDataDir: string;
  getWindow: () => BrowserWindow | null;
  emit?: (event: BrowserEvent) => void;
  onCapabilitySnapshot?: (snapshot: BrowserCapabilitySnapshot) => void;
  confirm?: (kind: BrowserConfirmationKind, language?: BrowserConfirmationLanguage) => Promise<boolean>;
  confirmSensitiveAction?: (description: string) => Promise<boolean>;
  confirmRouteBypass?: (origin: string, ruleId: string) => Promise<boolean>;
  confirmExternalProtocol?: (url: string) => Promise<boolean>;
  confirmPrivateNetwork?: (url: string) => Promise<boolean>;
  chooseSavePath?: (filename: string) => Promise<string | null>;
  chooseUploadPaths?: () => Promise<string[]>;
  secretCodec?: BrowserSecretCodec;
}

export class BrowserService {
  private readonly options: BrowserServiceOptions;
  private readonly settingsStore: BrowserSettingsStore;
  private readonly policy: BrowserPolicyEngine;
  private readonly persistentGrants: BrowserPersistentGrantStore;
  private readonly authorization: BrowserAuthorizationCoordinator;
  private readonly runtimeGrants = new Map<string, BrowserRuntimeSessionGrant>();
  private readonly confirmations = new BrowserConfirmationManager();
  private readonly secrets: BrowserSecretVault;
  private readonly profiles: BrowserProfileManager;
  private readonly tabs: BrowserTabManager;
  private readonly restoreStore: BrowserTabRestoreStore;
  private readonly headerStore: BrowserHeaderRuleStore;
  private readonly agentHeaderRules = new BrowserAgentHeaderRuleRegistry();
  private readonly snippetStore: BrowserSnippetStore;
  private readonly interceptors = new Map<string, BrowserNetworkInterceptor>();
  private readonly downloads = new Map<string, BrowserDownloadManager>();
  private restoreTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly pendingExternalProtocols = new Map<string, Promise<void>>();
  private readonly recentExternalProtocols = new Map<string, number>();
  private restored = false;
  private disposed = false;
  private readonly auditKey = randomBytes(32);

  constructor(options: BrowserServiceOptions) {
    this.options = options;
    this.settingsStore = new BrowserSettingsStore(path.join(options.userDataDir, "browser-settings.json"));
    this.persistentGrants = new BrowserPersistentGrantStore(
      path.join(options.userDataDir, "browser-session-grants.json"),
    );
    const parsed = this.settingsStore.get();
    this.policy = new BrowserPolicyEngine(parsed.settings);
    this.authorization = new BrowserAuthorizationCoordinator({
      getPersistentPermission: (sessionId) =>
        this.persistentGrants.get(sessionId)?.permission ?? this.policy.getSettings().automation.defaultPermission,
      isRendererAvailable: () => {
        const win = options.getWindow();
        return !!win && !win.isDestroyed() && !win.webContents.isDestroyed() && !win.webContents.isLoadingMainFrame();
      },
      grant: (sessionId, permission, source, grantSource) => {
        this.policy.grantSession({ sessionId, permission, source, expiresInMs: RUNTIME_GRANT_TTL_MS });
        this.runtimeGrants.set(sessionId, {
          sessionId,
          permission,
          scope: "session",
          source: grantSource,
          expiresAt: Date.now() + RUNTIME_GRANT_TTL_MS,
        });
        if (permission === "advanced" && this.policy.isAdvancedEnabled()) {
          void this.tabs?.applyAdvancedMode().catch(() => undefined);
        }
      },
      emitRequest: (request) => {
        const win = options.getWindow();
        if (win && !win.isDestroyed()) {
          if (win.isMinimized()) win.restore();
          if (!win.isVisible()) win.show();
        }
        this.emit({ type: "agent-authorization-request", request });
      },
      emitResolved: (requestId, outcome) => this.emit({ type: "agent-authorization-resolved", requestId, outcome }),
    });
    this.secrets = new BrowserSecretVault(
      path.join(options.userDataDir, "browser-secrets.json"),
      options.secretCodec ?? {
        isAvailable: () => safeStorage.isEncryptionAvailable(),
        encrypt: (value) => safeStorage.encryptString(value),
        decrypt: (value) => safeStorage.decryptString(value),
      },
    );
    this.restoreStore = new BrowserTabRestoreStore(path.join(options.userDataDir, "browser-tabs.json"));
    this.headerStore = new BrowserHeaderRuleStore(path.join(options.userDataDir, "browser-header-rules.json"));
    this.snippetStore = new BrowserSnippetStore(
      path.join(options.userDataDir, "browser-page-snippets.json"),
      () => this.policy.getSettings().advancedBrowserMode.maxPerHost,
    );
    this.profiles = new BrowserProfileManager({
      userDataDir: options.userDataDir,
      fromPartition: (partition, sessionOptions) => session.fromPartition(partition, sessionOptions),
      configureSession: (profile, browserSession) => this.configureSession(profile, browserSession),
    });
    this.tabs = new BrowserTabManager({
      getWindow: options.getWindow,
      profiles: this.profiles,
      getSettings: () => this.policy.getSettings(),
      getAdvancedRuntimePolicy: () => this.policy.getAdvancedRuntimePolicy(),
      networkBodyRoot: path.join(options.userDataDir, "browser-network-bodies"),
      emit: (event) => this.emit(event),
      confirmSensitiveAction: (description) =>
        options.confirmSensitiveAction?.(description) ?? this.defaultSensitiveActionConfirmation(description),
      openExternal: (url) => this.openExternalWithConfirmation(url),
      confirmPrivateNetwork: (url) =>
        options.confirmPrivateNetwork?.(url) ?? this.defaultPrivateNetworkConfirmation(url),
      approvePrivateOrigin: (profileId, origin) => this.interceptors.get(profileId)?.approvePrivateOrigin(origin),
    });
    this.policy.subscribe((snapshot) => {
      options.onCapabilitySnapshot?.(snapshot);
      this.emit({ type: "policy-changed", revision: snapshot.revision, snapshot });
    });
  }

  getState(): BrowserRendererState {
    const settings = this.getSettings();
    return {
      settings,
      capabilities: this.policy.getSnapshot(),
      tabs: this.tabs.list(),
      profiles: this.profiles.list(),
      activeTabId: this.tabs.getActiveTabId(),
      surfaceVisible: this.tabs.isSurfaceVisible(),
      downloads: [...this.downloads.values()].flatMap((manager) => manager.list()),
      permissionRequests: [...this.interceptors.values()].flatMap((interceptor) =>
        interceptor.listPermissionRequests(),
      ),
      persistentSessionPermissions: Object.fromEntries(
        this.persistentGrants.list().map((grant) => [grant.sessionId, grant.permission]),
      ),
      runtimeSessionGrants: Object.fromEntries(
        [...this.runtimeGrants.entries()]
          .filter(([, grant]) => grant.expiresAt > Date.now() && settings.settings.enabled)
          .filter(([sessionId]) => this.policy.getSnapshot().sessionPermissions[sessionId] !== undefined),
      ),
      diagnostics: this.getDiagnostics(),
    };
  }

  getSettings(): BrowserSettingsPublic {
    const parsed = this.settingsStore.get();
    return {
      settings: this.policy.getSettings(),
      runtime: {
        policyRevision: this.policy.getRevision(),
        advancedBrowserModeEnabled: this.policy.isAdvancedEnabled(),
        advancedTabCount: countAdvancedProfileTabs(this.tabs.list()),
      },
      compatibilityReadOnly: parsed.compatibilityReadOnly,
    };
  }

  async requestConfirmation(
    kind: BrowserConfirmationKind,
    payload: BrowserSettingsPatch | undefined,
    language?: BrowserConfirmationLanguage,
  ): Promise<BrowserConfirmationProof | null> {
    if (kind !== "advanced-browser-mode" && kind !== "sensitive-cookies") {
      throw new BrowserError("INVALID_BROWSER_REQUEST", "Browser confirmation kind is invalid");
    }
    const confirmationPayload =
      kind === "advanced-browser-mode" && payload
        ? prepareBrowserSettingsUpdate(this.policy.getSettings(), payload).canonicalPatch
        : (payload ?? null);
    const normalizedLanguage = language === "zh-CN" ? "zh-CN" : "en-US";
    const accepted = await (this.options.confirm?.(kind, normalizedLanguage) ??
      this.defaultConfirmation(kind, normalizedLanguage));
    return accepted ? this.confirmations.issue(kind, confirmationPayload) : null;
  }

  updateSettings(patch: BrowserSettingsPatch, proof?: BrowserConfirmationProof): BrowserSettingsPublic {
    const before = this.policy.getSettings();
    const canonicalPatch = authorizeBrowserSettingsUpdate(before, patch, (payload) =>
      this.confirmations.consume(proof, "advanced-browser-mode", payload),
    );
    const parsed = this.settingsStore.update(canonicalPatch);
    const persistentDefaultChanged =
      before.automation.defaultPermission !== parsed.settings.automation.defaultPermission;
    const capabilityBoundaryChanged =
      before.enabled !== parsed.settings.enabled ||
      before.automation.enabled !== parsed.settings.automation.enabled ||
      before.automation.allowChannelSessions !== parsed.settings.automation.allowChannelSessions ||
      before.advancedBrowserMode.enabled !== parsed.settings.advancedBrowserMode.enabled;
    if (capabilityBoundaryChanged) {
      this.authorization.cancelAll();
      this.policy.revokeAll();
      this.runtimeGrants.clear();
    } else if (persistentDefaultChanged) {
      this.policy.revokeAll();
      this.runtimeGrants.clear();
    }
    this.policy.updateSettings(parsed.settings);
    if (persistentDefaultChanged) {
      for (const pending of this.authorization.listPending()) {
        this.authorization.persistentPolicyChanged(pending.sessionId);
      }
    }
    this.applySettingsSideEffects(before, parsed.settings);
    return this.getSettings();
  }

  listTabs(sessionId?: string): BrowserTabInfo[] {
    return this.tabs.list(sessionId);
  }

  createUserTab(input: BrowserCreateTabInput): Promise<BrowserTabInfo> {
    return this.tabs.create(input);
  }

  activateTab(tabId: string): void {
    this.tabs.activate(tabId);
  }

  async navigateUser(tabId: string, url: string): Promise<void> {
    await this.tabs.navigate(tabId, url, undefined, true);
  }

  async goBack(tabId: string): Promise<void> {
    await this.tabs.goBack(tabId);
  }

  async goForward(tabId: string): Promise<void> {
    await this.tabs.goForward(tabId);
  }

  async reload(tabId: string): Promise<void> {
    await this.tabs.reload(tabId);
  }

  stop(tabId: string): void {
    this.tabs.stop(tabId);
  }

  closeTab(tabId: string): void {
    this.tabs.close(tabId);
  }

  closeAllTabs(): void {
    this.tabs.closeAll();
  }

  handleWindowClosed(): void {
    this.persistRestoreTabs();
    this.tabs.setSurfaceVisible({ visible: false });
    this.tabs.closeAll();
    if (this.restoreTimer) {
      clearTimeout(this.restoreTimer);
      this.restoreTimer = null;
    }
    this.restored = false;
  }

  setBounds(input: Parameters<BrowserTabManager["setBounds"]>[0]): void {
    this.tabs.setBounds(input);
  }

  setSurfaceVisible(input: { tabId?: string; visible: boolean }): void {
    this.tabs.setSurfaceVisible(input);
  }

  handleWindowVisibility(visible: boolean): void {
    this.tabs.setWindowVisible(visible);
  }

  handleRendererUnavailable(): void {
    // WebContentsView is owned by Main and survives a Renderer reload. Clear
    // the requested visibility as well as the current visibility so a later
    // window restore cannot expose a stale native surface over the new UI.
    this.tabs.hideSurfaceForRendererUnavailable();
    this.authorization.cancelAll();
  }

  grantSession(input: BrowserSessionGrantInput): void {
    this.policy.grantSession(input);
    if (input.permission !== "none") {
      this.runtimeGrants.set(input.sessionId, {
        sessionId: input.sessionId,
        permission: input.permission,
        scope: "session",
        source: "user-prompt",
        expiresAt: Date.now() + (input.expiresInMs ?? RUNTIME_GRANT_TTL_MS),
      });
    }
    if (input.permission === "advanced" && this.policy.isAdvancedEnabled()) {
      void this.tabs.applyAdvancedMode().catch((error) => {
        appendMainLog(
          `Browser advanced state restore failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      });
    }
  }

  revokeSession(sessionId: string): void {
    this.clearAgentHeaderRules(sessionId);
    this.policy.revokeSession(sessionId);
    this.runtimeGrants.delete(sessionId);
    this.authorization.cancelSession(sessionId);
    this.tabs.revokeAgentActions(sessionId);
  }

  setPersistentSessionPermission(sessionId: string, permission: BrowserPersistentSessionPermission): void {
    this.clearAgentHeaderRules(sessionId);
    this.persistentGrants.set(sessionId, permission);
    this.policy.revokeSession(sessionId);
    this.runtimeGrants.delete(sessionId);
    this.tabs.revokeAgentActions(sessionId);
    this.authorization.persistentPolicyChanged(sessionId);
  }

  revokeTemporarySessionPermission(sessionId: string): void {
    this.revokeSession(sessionId);
  }

  respondAgentAuthorization(requestId: string, decision: BrowserAgentAuthorizationDecision): void {
    this.authorization.respond(requestId, decision);
  }

  listProfiles(): BrowserProfileInfo[] {
    return this.profiles.list();
  }

  createProfile(input: BrowserCreateProfileInput): BrowserProfileInfo {
    if (input.mode === "unsafe" && !this.policy.isAdvancedEnabled()) {
      throw new BrowserError(
        "ADVANCED_BROWSER_MODE_REQUIRED",
        "Enable Advanced Browser Mode before creating an advanced Profile",
      );
    }
    return this.profiles.create(input);
  }

  renameProfile(profileId: string, name: string): BrowserProfileInfo {
    return this.profiles.rename(profileId, name);
  }

  async deleteProfile(profileId: string): Promise<void> {
    for (const tab of this.tabs.list().filter((candidate) => candidate.profileId === profileId))
      this.tabs.close(tab.id);
    this.interceptors.get(profileId)?.dispose();
    this.downloads.get(profileId)?.dispose();
    this.interceptors.delete(profileId);
    this.downloads.delete(profileId);
    const removedAgentRules = this.agentHeaderRules.clearProfile(profileId).rules;
    const removedRules = [
      ...this.headerStore.get(profileId, "request"),
      ...this.headerStore.get(profileId, "response"),
      ...removedAgentRules,
    ];
    this.headerStore.clearProfile(profileId);
    this.removeUnusedHeaderSecrets(removedRules);
    await this.profiles.delete(profileId);
    if (this.policy.getSettings().panel.defaultProfileId === profileId) {
      this.updateSettings({ panel: { defaultProfileId: DEFAULT_BROWSER_PROFILE_ID } });
    }
  }

  async clearProfileData(profileId: string, dataType: BrowserDataType): Promise<void> {
    for (const tab of this.tabs.list().filter((candidate) => candidate.profileId === profileId))
      this.tabs.close(tab.id);
    await this.profiles.clearData(profileId, dataType);
  }

  setProxyCredentials(credentials: BrowserProxyCredentialsInput | null): BrowserSettingsPublic {
    const currentRef = this.policy.getSettings().proxy.credentialSecretRef;
    if (credentials === null) {
      if (currentRef) this.secrets.remove(currentRef);
      return this.updateSettings({ proxy: { credentialSecretRef: undefined } });
    }
    const username = validateCredentialPart(credentials.username, 1_024, "username", false);
    const password = validateCredentialPart(credentials.password, 16 * 1_024, "password", false);
    const ref = this.secrets.set(JSON.stringify({ username, password }), currentRef);
    return this.updateSettings({ proxy: { credentialSecretRef: ref } });
  }

  getHeaderRules(profileId: string, direction: BrowserHeaderRuleDirection): BrowserHeaderRule[] {
    this.profiles.get(profileId);
    assertHeaderDirection(direction);
    return this.headerStore.get(profileId, direction);
  }

  setLocalHeaderRules(profileId: string, direction: BrowserHeaderRuleDirection, rules: BrowserHeaderRule[]): void {
    assertHeaderDirection(direction);
    this.assertAdvancedMode();
    this.setLocalRules(profileId, direction, rules);
  }

  storeHeaderSecret(value: string, existingRef?: string): string {
    if (!this.policy.isAdvancedEnabled()) {
      throw new BrowserError("CAPABILITY_DISABLED", "Advanced Browser capabilities are disabled");
    }
    return this.secrets.set(value, existingRef);
  }

  removeHeaderSecret(secretRef: string): void {
    this.secrets.remove(secretRef);
  }

  listPageSnippets(): BrowserPageSnippetSummary[] {
    return this.snippetStore.listAll();
  }

  setPageSnippetEnabled(snippetId: string, enabled: boolean): void {
    this.snippetStore.setEnabled(snippetId, enabled);
  }

  deletePageSnippet(snippetId: string): void {
    this.snippetStore.delete(snippetId);
  }

  clearPageSnippets(): void {
    this.snippetStore.clear();
  }

  getProxyCredentialsForWebContents(
    webContentsId: number,
    isProxy: boolean,
  ): { username: string; password: string } | undefined {
    if (!isProxy || !this.tabs.hasWebContents(webContentsId)) return undefined;
    const proxy = this.policy.getSettings().proxy;
    if (proxy.mode !== "custom" || !proxy.credentialSecretRef) return undefined;
    const encoded = this.secrets.get(proxy.credentialSecretRef);
    if (!encoded) return undefined;
    try {
      const parsed = JSON.parse(encoded) as Partial<BrowserProxyCredentialsInput>;
      if (typeof parsed.username !== "string" || typeof parsed.password !== "string") return undefined;
      return { username: parsed.username, password: parsed.password };
    } catch {
      return undefined;
    }
  }

  respondPermission(requestId: string, decision: BrowserPermissionDecision): void {
    if (decision !== "allow-once" && decision !== "allow-session" && decision !== "deny") {
      throw new BrowserError("INVALID_BROWSER_REQUEST", "Browser permission decision is invalid");
    }
    for (const interceptor of this.interceptors.values()) {
      if (interceptor.listPermissionRequests().some((request) => request.id === requestId)) {
        interceptor.respondPermission(requestId, decision);
        return;
      }
    }
    throw new BrowserError("INVALID_BROWSER_REQUEST", "Browser permission request was not found");
  }

  async chooseUploadFiles(tabId: string): Promise<string[]> {
    const paths = await (this.options.chooseUploadPaths?.() ?? this.defaultChooseUploadPaths());
    if (paths.length) await this.tabs.chooseUploadFiles(tabId, paths);
    return paths;
  }

  async reset(): Promise<BrowserRendererState> {
    this.tabs.closeAll();
    this.policy.revokeAll();
    this.authorization.cancelAll();
    this.runtimeGrants.clear();
    this.persistentGrants.clear();
    const settings = this.settingsStore.reset().settings;
    this.policy.updateSettings(settings);
    this.confirmations.clear();
    this.agentHeaderRules.clear();
    this.headerStore.clear();
    this.secrets.clear();
    this.restoreStore.clear();
    this.snippetStore.clear();
    for (const interceptor of this.interceptors.values()) interceptor.clearAdvancedRules();
    return this.getState();
  }

  async restoreTabs(): Promise<void> {
    if (this.restored || this.disposed) return;
    this.restored = true;
    const settings = this.policy.getSettings();
    if (!settings.enabled || !settings.panel.restoreTabs) return;
    const profileIds = new Set(
      this.profiles
        .list()
        .filter((profile) => profile.mode !== "unsafe")
        .map((profile) => profile.id),
    );
    for (const record of this.restoreStore.read().sort((left, right) => left.order - right.order)) {
      if (!profileIds.has(record.profileId)) continue;
      try {
        await this.tabs.create({
          profileId: record.profileId,
          url: record.url,
          ownerSessionId: record.ownerSessionId,
          activate: false,
        });
      } catch {
        // One unavailable URL/Profile must not prevent restoring other tabs.
      }
    }
    const first = this.tabs.list()[0];
    if (first) this.tabs.activate(first.id);
  }

  getCapabilitySnapshot(): BrowserCapabilitySnapshot {
    return this.policy.getSnapshot();
  }

  getRedactedDiagnostics(): BrowserDiagnostics {
    return this.getDiagnostics();
  }

  async handleHostRequest(method: string, params: unknown): Promise<unknown> {
    if (!isBrowserHostMethod(method)) throw new BrowserError("INVALID_BROWSER_REQUEST", "Unknown Browser Host method");
    try {
      const result = await this.dispatchHostRequest(method, params as never);
      if (method !== "browser.capabilities") this.auditHostRequest(method, params, "OK");
      return result;
    } catch (error) {
      const browserError = asBrowserError(error);
      if (method !== "browser.capabilities") this.auditHostRequest(method, params, browserError.code);
      throw browserError;
    }
  }

  onHostStopped(): void {
    this.clearAgentHeaderRules();
    this.authorization.cancelAll();
    this.policy.revokeAll();
    this.runtimeGrants.clear();
    this.tabs.revokeAgentActions();
    void this.tabs.clearAdvancedState().catch((error) => {
      appendMainLog(`Browser advanced state cleanup failed: ${error instanceof Error ? error.message : String(error)}`);
    });
  }

  handleCertificateError(webContentsId: number, hostname: string): boolean {
    if (!this.tabs.isAdvancedWebContents(webContentsId)) return false;
    const advanced = this.policy.getAdvancedRuntimePolicy();
    return advanced.enabled && advanced.certificateBypassDomains.includes(hostname.trim().toLowerCase());
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    if (this.restoreTimer) clearTimeout(this.restoreTimer);
    this.persistRestoreTabs();
    this.confirmations.clear();
    this.clearAgentHeaderRules(undefined, false);
    this.authorization.cancelAll();
    this.policy.revokeAll();
    this.runtimeGrants.clear();
    this.tabs.dispose();
    for (const manager of this.downloads.values()) manager.dispose();
    for (const interceptor of this.interceptors.values()) interceptor.dispose();
    this.downloads.clear();
    this.interceptors.clear();
    this.pendingExternalProtocols.clear();
    this.recentExternalProtocols.clear();
    await this.profiles.dispose();
  }

  private configureSession(profile: BrowserProfileInfo, browserSession: Session): void {
    browserSession.setDevicePermissionHandler(() => false);
    if (profile.mode === "unsafe") {
      browserSession.setCertificateVerifyProc((request, callback) => {
        const advanced = this.policy.getAdvancedRuntimePolicy();
        callback(
          advanced.enabled && advanced.certificateBypassDomains.includes(request.hostname.trim().toLowerCase())
            ? 0
            : request.errorCode,
        );
      });
    }
    const interceptor = new BrowserNetworkInterceptor({
      session: browserSession,
      profileId: profile.id,
      getNavigationSettings: () => this.policy.getSettings().navigation,
      getAdvancedRuntimePolicy: () =>
        profile.mode === "unsafe" ? this.policy.getAdvancedRuntimePolicy() : createDisabledAdvancedRuntimePolicy(),
      getTabForWebContents: (id) => this.tabs.getTabForWebContents(id),
      getIdentityForWebContents: (id) => this.tabs.getIdentityForWebContents(id),
      resolveSecret: (ref) => this.secrets.get(ref),
      emit: (event) => this.emit(event),
      onBlockedRequest: (url, code) => {
        if (code === "UNSUPPORTED_PROTOCOL" && /^mailto:/i.test(url)) {
          void this.openExternalWithConfirmation(url).catch(() => undefined);
        }
      },
    });
    this.interceptors.set(profile.id, interceptor);
    this.applyStoredHeaderRules(profile.id, interceptor);

    const downloadManager = new BrowserDownloadManager({
      session: browserSession,
      getSettings: () => this.policy.getSettings().downloads,
      getTabForWebContents: (id) => this.tabs.getTabForWebContents(id),
      chooseSavePath: (filename) => this.options.chooseSavePath?.(filename) ?? this.defaultChooseSavePath(filename),
      emit: (event) => this.emit(event),
    });
    this.downloads.set(profile.id, downloadManager);
    const proxy = this.policy.getSettings().proxy;
    const proxyOptions =
      proxy.mode === "custom"
        ? {
            mode: "fixed_servers" as const,
            proxyRules: proxy.proxyRules,
            ...(proxy.proxyBypassRules ? { proxyBypassRules: proxy.proxyBypassRules } : {}),
          }
        : { mode: proxy.mode };
    void browserSession.setProxy(proxyOptions).catch(() => undefined);
  }

  private applyStoredHeaderRules(profileId: string, interceptor: BrowserNetworkInterceptor): void {
    if (!this.policy.isAdvancedEnabled()) return;
    interceptor.setRequestRules(this.combinedHeaderRules(profileId, "request"));
    interceptor.setResponseRules(this.combinedHeaderRules(profileId, "response"));
  }

  private applySettingsSideEffects(before: ReturnType<BrowserPolicyEngine["getSettings"]>, after: typeof before): void {
    if (
      JSON.stringify(before.automation) !== JSON.stringify(after.automation) ||
      JSON.stringify(before.advancedBrowserMode) !== JSON.stringify(after.advancedBrowserMode)
    ) {
      this.tabs.revokeAgentActions();
    }
    if (!after.enabled) this.tabs.closeAll();
    if (!after.automation.enabled) this.tabs.revokeAgentActions();
    if (!this.policy.isAdvancedEnabled()) {
      this.clearAgentHeaderRules();
      void this.tabs.clearAdvancedState();
      this.tabs.closeAll({ unsafeOnly: true });
      for (const interceptor of this.interceptors.values()) interceptor.clearAdvancedRules();
    } else {
      for (const [profileId, interceptor] of this.interceptors) {
        this.applyStoredHeaderRules(profileId, interceptor);
      }
      void this.tabs.applyAdvancedMode().catch(() => undefined);
    }
    if (
      before.proxy.mode !== after.proxy.mode ||
      before.proxy.proxyRules !== after.proxy.proxyRules ||
      before.proxy.proxyBypassRules !== after.proxy.proxyBypassRules
    ) {
      for (const profile of this.profiles.list()) void this.applyProxy(profile.id).catch(() => undefined);
    }
    if (!after.panel.restoreTabs) this.restoreStore.clear();
  }

  private async applyProxy(profileId: string): Promise<void> {
    await this.profiles.applyProxy(profileId, this.policy.getSettings().proxy);
  }

  private async dispatchHostRequest<M extends BrowserHostMethod>(
    method: M,
    params: BrowserHostParams<M>,
  ): Promise<BrowserHostResult<M>> {
    if (!params || typeof params !== "object") {
      throw new BrowserError("INVALID_BROWSER_REQUEST", "Browser Host request parameters are invalid");
    }
    if (method === "browser.capabilities") {
      const body = params as BrowserHostParams<"browser.capabilities">;
      let lease = this.policy.getLeaseForSession(body.sessionId);
      if (!lease) {
        try {
          lease = this.policy.issueLease(body.sessionId);
        } catch {
          // A capability query is allowed to report no grant.
        }
      }
      return { snapshot: this.policy.getSnapshot(), ...(lease ? { lease } : {}) } as BrowserHostResult<M>;
    }
    if (method === "browser.requestAuthorization") {
      const body = params as BrowserHostParams<"browser.requestAuthorization">;
      if (
        !isBrowserHostMethod(body.targetMethod) ||
        body.targetMethod === "browser.capabilities" ||
        body.targetMethod === "browser.requestAuthorization" ||
        body.targetMethod === "browser.sessionEnded" ||
        body.targetMethod === "browser.requestRouteBypass" ||
        typeof body.requestId !== "string" ||
        !body.requestId ||
        body.requestId.length > 256 ||
        /[\0\r\n]/.test(body.requestId) ||
        (body.source !== "local" && body.source !== "channel")
      ) {
        throw new BrowserError("INVALID_BROWSER_REQUEST", "Browser authorization preflight is invalid");
      }
      const minimumPermission = requiredPermission(body.targetMethod);
      const currentSettings = this.policy.getSettings();
      if (body.source === "channel" && !currentSettings.automation.allowChannelSessions) {
        throw new BrowserError("CAPABILITY_DISABLED", "Browser access for channel sessions is disabled");
      }
      await this.authorization.request(body.sessionId, body.source, minimumPermission);
      return {
        snapshot: this.policy.getSnapshot(),
        lease: this.policy.issueLease(body.sessionId),
      } as BrowserHostResult<M>;
    }
    if (method === "browser.sessionEnded") {
      const body = params as BrowserHostParams<"browser.sessionEnded">;
      this.revokeSession(body.sessionId);
      this.tabs.clearSessionState(body.sessionId);
      this.persistentGrants.delete(body.sessionId);
      return { ok: true } as BrowserHostResult<M>;
    }
    if (method === "browser.requestRouteBypass") {
      const body = params as BrowserHostParams<"browser.requestRouteBypass">;
      if (
        typeof body.sessionId !== "string" ||
        !body.sessionId ||
        body.sessionId.length > 256 ||
        typeof body.requestId !== "string" ||
        !body.requestId ||
        body.requestId.length > 256 ||
        !["browser-policy-denied", "browser-unsupported-route"].includes(body.ruleId)
      ) {
        throw new BrowserError("INVALID_BROWSER_REQUEST", "Browser route bypass request is invalid");
      }
      let origin: string;
      try {
        const parsed = new URL(body.origin);
        if ((parsed.protocol !== "http:" && parsed.protocol !== "https:") || parsed.origin !== body.origin) {
          throw new Error("origin required");
        }
        origin = parsed.origin;
      } catch {
        throw new BrowserError("INVALID_BROWSER_REQUEST", "Browser route bypass origin is invalid");
      }
      const allowed = await (this.options.confirmRouteBypass?.(origin, body.ruleId) ??
        this.defaultConfirmRouteBypass(origin));
      return { allowed } as BrowserHostResult<M>;
    }
    const context = params as BrowserHostParams<
      Exclude<
        M,
        "browser.capabilities" | "browser.requestAuthorization" | "browser.sessionEnded" | "browser.requestRouteBypass"
      >
    >;
    const permission = requiredPermission(method);
    this.policy.assertRequest(context, permission);

    switch (method) {
      case "browser.open": {
        const body = params as BrowserHostParams<"browser.open">;
        const tab = await this.tabs.create({
          url: body.url,
          profileId: body.profileId,
          activate: body.activate,
          ownerSessionId: body.sessionId,
        });
        return {
          ...tab,
          siteSnippetCount: this.policy.isAdvancedEnabled() ? this.snippetStore.listForUrl(tab.url).siteCount : 0,
        } as BrowserHostResult<M>;
      }
      case "browser.listTabs":
        return { tabs: this.tabs.list(context.sessionId) } as BrowserHostResult<M>;
      case "browser.navigate": {
        const body = params as BrowserHostParams<"browser.navigate">;
        return (await this.tabs.navigate(body.tabId, body.url, body.sessionId)) as BrowserHostResult<M>;
      }
      case "browser.snapshot": {
        const body = params as BrowserHostParams<"browser.snapshot">;
        return (await this.tabs.snapshot(body.tabId, body.sessionId, body)) as BrowserHostResult<M>;
      }
      case "browser.inspect": {
        const body = params as BrowserHostParams<"browser.inspect">;
        return (await this.tabs.inspect(body.sessionId, body)) as BrowserHostResult<M>;
      }
      case "browser.screenshot": {
        const body = params as BrowserHostParams<"browser.screenshot">;
        return (await this.tabs.screenshot(body.tabId, body.sessionId, body)) as BrowserHostResult<M>;
      }
      case "browser.click": {
        const body = params as BrowserHostParams<"browser.click">;
        return (await this.tabs.click(
          body.tabId,
          body.sessionId,
          body.ref,
          body.snapshotId,
          body.generation,
          body.button,
          body.clickCount,
          body.modifiers,
        )) as BrowserHostResult<M>;
      }
      case "browser.clickAt": {
        const body = params as BrowserHostParams<"browser.clickAt">;
        return (await this.tabs.clickAt(
          body.tabId,
          body.sessionId,
          body.x,
          body.y,
          body.button,
          body.clickCount,
          body.modifiers,
        )) as BrowserHostResult<M>;
      }
      case "browser.type": {
        const body = params as BrowserHostParams<"browser.type">;
        const inputPath = await this.tabs.type(
          body.tabId,
          body.sessionId,
          body.ref,
          body.snapshotId,
          body.generation,
          body.text,
          body.submit,
        );
        return { ok: true, inputPath } as BrowserHostResult<M>;
      }
      case "browser.press": {
        const body = params as BrowserHostParams<"browser.press">;
        await this.tabs.press(body.tabId, body.sessionId, body.key, body.modifiers);
        return { ok: true } as BrowserHostResult<M>;
      }
      case "browser.scroll": {
        const body = params as BrowserHostParams<"browser.scroll">;
        await this.tabs.scroll(body.tabId, body.sessionId, body);
        return { ok: true } as BrowserHostResult<M>;
      }
      case "browser.wait": {
        const body = params as BrowserHostParams<"browser.wait">;
        const elapsedMs = await this.tabs.wait(body.tabId, body.sessionId, body);
        return { ok: true, elapsedMs } as BrowserHostResult<M>;
      }
      case "browser.back": {
        const body = params as BrowserHostParams<"browser.back">;
        return (await this.tabs.goBack(body.tabId, body.sessionId)) as BrowserHostResult<M>;
      }
      case "browser.forward": {
        const body = params as BrowserHostParams<"browser.forward">;
        return (await this.tabs.goForward(body.tabId, body.sessionId)) as BrowserHostResult<M>;
      }
      case "browser.reload": {
        const body = params as BrowserHostParams<"browser.reload">;
        return (await this.tabs.reload(body.tabId, body.sessionId)) as BrowserHostResult<M>;
      }
      case "browser.close": {
        const body = params as BrowserHostParams<"browser.close">;
        this.tabs.close(body.tabId, body.sessionId);
        return { ok: true } as BrowserHostResult<M>;
      }
      case "browser.executeJavaScript": {
        const body = params as BrowserHostParams<"browser.executeJavaScript">;
        this.assertAdvancedMode();
        const result = await this.tabs.executeJavaScript(body.tabId, body.sessionId, body.source, body);
        if (body.remember === true) {
          if (!body.purpose) {
            throw new BrowserError("INVALID_BROWSER_REQUEST", "A purpose is required to remember Browser JavaScript");
          }
          if (!result.exception) {
            const saved = this.snippetStore.save({
              pageUrl: this.tabs.getOwnedTabUrl(body.tabId, body.sessionId),
              label: body.purpose,
              code: body.source,
              resultPreview: previewSnippetResult(result.value),
            });
            return { ...result, snippetId: saved.id } as BrowserHostResult<M>;
          }
        }
        return result as BrowserHostResult<M>;
      }
      case "browser.getCookies": {
        const body = params as BrowserHostParams<"browser.getCookies">;
        return (await this.getCookies(body)) as BrowserHostResult<M>;
      }
      case "browser.setCookies": {
        const body = params as BrowserHostParams<"browser.setCookies">;
        await this.setCookies(body.profileId, body.cookies);
        return { ok: true } as BrowserHostResult<M>;
      }
      case "browser.setRequestHeaderRules": {
        const body = params as BrowserHostParams<"browser.setRequestHeaderRules">;
        this.assertAdvancedMode();
        this.setAgentRules(body.profileId, "request", body.sessionId, body.rules);
        return { ok: true } as BrowserHostResult<M>;
      }
      case "browser.setResponseHeaderRules": {
        const body = params as BrowserHostParams<"browser.setResponseHeaderRules">;
        this.assertAdvancedMode();
        this.setAgentRules(body.profileId, "response", body.sessionId, body.rules);
        return { ok: true } as BrowserHostResult<M>;
      }
      case "browser.sendCdpCommand": {
        const body = params as BrowserHostParams<"browser.sendCdpCommand">;
        this.assertCdpMethod(body.method, body.tabId, body.sessionId);
        return (await this.tabs.sendCdpCommand(
          body.tabId,
          body.sessionId,
          body.method,
          body.commandParams,
        )) as BrowserHostResult<M>;
      }
      case "browser.networkList": {
        const body = params as BrowserHostParams<"browser.networkList">;
        this.assertAdvancedMode();
        return (await this.tabs.networkList(body.tabId, body.sessionId, body)) as BrowserHostResult<M>;
      }
      case "browser.networkWait": {
        const body = params as BrowserHostParams<"browser.networkWait">;
        this.assertAdvancedMode();
        return (await this.tabs.networkWait(body.tabId, body.sessionId, body)) as BrowserHostResult<M>;
      }
      case "browser.networkBody": {
        const body = params as BrowserHostParams<"browser.networkBody">;
        this.assertAdvancedMode();
        return (await this.tabs.networkBody(
          body.tabId,
          body.sessionId,
          body.networkRequestId,
          body,
        )) as BrowserHostResult<M>;
      }
      case "browser.networkReplay": {
        const body = params as BrowserHostParams<"browser.networkReplay">;
        this.assertAdvancedMode();
        return (await this.tabs.networkReplay(
          body.tabId,
          body.sessionId,
          body.networkRequestId,
          body.overrides,
          body.reason,
        )) as BrowserHostResult<M>;
      }
      case "browser.networkSummary": {
        const body = params as BrowserHostParams<"browser.networkSummary">;
        this.assertAdvancedMode();
        return (await this.tabs.networkSummary(body.tabId, body.sessionId, body)) as BrowserHostResult<M>;
      }
      case "browser.consoleList": {
        const body = params as BrowserHostParams<"browser.consoleList">;
        this.assertAdvancedMode();
        return (await this.tabs.consoleList(body.tabId, body.sessionId, body)) as BrowserHostResult<M>;
      }
      case "browser.consoleWait": {
        const body = params as BrowserHostParams<"browser.consoleWait">;
        this.assertAdvancedMode();
        return (await this.tabs.consoleWait(body.tabId, body.sessionId, body)) as BrowserHostResult<M>;
      }
      case "browser.visualCompare": {
        const body = params as BrowserHostParams<"browser.visualCompare">;
        return (await this.tabs.visualCompare(body.sessionId, body)) as BrowserHostResult<M>;
      }
      case "browser.pageCodeList": {
        const body = params as BrowserHostParams<"browser.pageCodeList">;
        this.assertAdvancedMode();
        return this.snippetStore.listForUrl(
          this.tabs.getOwnedTabUrl(body.tabId, body.sessionId),
          body.limit,
        ) as BrowserHostResult<M>;
      }
      case "browser.pageCodeGet": {
        const body = params as BrowserHostParams<"browser.pageCodeGet">;
        this.assertAdvancedMode();
        return this.snippetStore.getForUrl(
          this.tabs.getOwnedTabUrl(body.tabId, body.sessionId),
          body.snippetId,
          body.offset,
          body.maxChars,
        ) as BrowserHostResult<M>;
      }
      default:
        throw new BrowserError("INVALID_BROWSER_REQUEST", "Unsupported Browser Host method");
    }
  }

  private async getCookies(body: BrowserHostParams<"browser.getCookies">): Promise<BrowserCookiePage> {
    void body;
    // Research Gate A: Pi's current ToolResult persistence path does not provide a
    // verified model-only/full-value channel. Do not return account credentials into
    // session JSONL until that invariant exists and is covered by reload/compaction tests.
    throw new BrowserError(
      "SENSITIVE_RESULT_UNAVAILABLE",
      "Full cookie values are unavailable because sensitive ToolResult persistence isolation is not verified",
    );
  }

  private async setCookies(profileId: string, cookies: BrowserCookieRecord[]): Promise<void> {
    void profileId;
    void cookies;
    // Cookie mutation values would be persisted in the model-generated tool-call
    // input even if the result were redacted. Gate A therefore applies to writes
    // as well as reads until the Pi session layer has a verified secret channel.
    throw new BrowserError(
      "SENSITIVE_RESULT_UNAVAILABLE",
      "Cookie mutation is unavailable because sensitive ToolResult persistence isolation is not verified",
    );
  }

  private validateHeaderRuleInput(
    profileId: string,
    direction: BrowserHeaderRuleDirection,
    rules: BrowserHeaderRule[],
  ): BrowserHeaderRule[] {
    this.profiles.get(profileId);
    const advanced = this.policy.getAdvancedRuntimePolicy();
    const profile = this.profiles.get(profileId);
    return validateHeaderRules(
      profileId,
      rules,
      direction,
      profile.mode === "unsafe" && advanced.enabled && advanced.removeSiteSecurityHeaders,
    );
  }

  private setLocalRules(profileId: string, direction: BrowserHeaderRuleDirection, rules: BrowserHeaderRule[]): void {
    const previous = this.headerStore.get(profileId, direction);
    const validated = this.validateHeaderRuleInput(profileId, direction, rules)
      .filter((rule) => !rule.secretRef || this.secrets.has(rule.secretRef))
      .map((rule) => ({ ...rule, source: "local" as const, ownerSessionId: undefined }));
    this.headerStore.set(profileId, direction, validated);
    this.applyHeaderRuleScope(profileId, direction);
    this.removeUnusedHeaderSecrets(previous);
  }

  private setAgentRules(
    profileId: string,
    direction: BrowserHeaderRuleDirection,
    sessionId: string,
    rules: BrowserHeaderRule[],
  ): void {
    const validated = this.validateHeaderRuleInput(profileId, direction, rules).filter(
      (rule) => !rule.secretRef || this.secrets.has(rule.secretRef),
    );
    const previous = this.agentHeaderRules.set(profileId, direction, sessionId, validated);
    this.applyHeaderRuleScope(profileId, direction);
    this.removeUnusedHeaderSecrets(previous);
  }

  private combinedHeaderRules(profileId: string, direction: BrowserHeaderRuleDirection): BrowserHeaderRule[] {
    return [...this.headerStore.get(profileId, direction), ...this.agentHeaderRules.get(profileId, direction)];
  }

  private applyHeaderRuleScope(profileId: string, direction: BrowserHeaderRuleDirection): void {
    const interceptor =
      this.interceptors.get(profileId) ?? (this.profiles.getSession(profileId), this.interceptors.get(profileId));
    if (!interceptor) throw new BrowserError("CAPABILITY_DISABLED", "Browser Profile session is unavailable");
    const combined = this.combinedHeaderRules(profileId, direction);
    if (direction === "request") interceptor.setRequestRules(combined);
    else interceptor.setResponseRules(combined);
  }

  private clearAgentHeaderRules(sessionId?: string, refreshInterceptors = true): void {
    const removed = sessionId ? this.agentHeaderRules.clearSession(sessionId) : this.agentHeaderRules.clear();
    if (refreshInterceptors && this.policy.isAdvancedEnabled()) {
      for (const scope of removed.scopes) {
        if (this.interceptors.has(scope.profileId)) this.applyHeaderRuleScope(scope.profileId, scope.direction);
      }
    }
    this.removeUnusedHeaderSecrets(removed.rules);
  }

  private removeUnusedHeaderSecrets(rules: readonly BrowserHeaderRule[]): void {
    const refs = new Set(rules.flatMap((rule) => (rule.secretRef ? [rule.secretRef] : [])));
    for (const ref of refs) {
      if (!this.headerStore.hasSecretRef(ref) && !this.agentHeaderRules.hasSecretRef(ref)) this.secrets.remove(ref);
    }
  }

  private assertAdvancedMode(): void {
    if (!this.policy.isAdvancedEnabled()) {
      throw new BrowserError("ADVANCED_BROWSER_MODE_REQUIRED", "Advanced Browser Mode is disabled");
    }
  }

  private assertCdpMethod(method: string, tabId: string, sessionId: string): void {
    if (typeof method !== "string" || !/^[A-Za-z]+\.[A-Za-z][A-Za-z0-9]*$/.test(method)) {
      throw new BrowserError("INVALID_BROWSER_REQUEST", "CDP method is invalid");
    }
    void tabId;
    void sessionId;
    this.assertAdvancedMode();
  }

  private emit(event: BrowserEvent): void {
    this.options.emit?.(event);
    if (event.type === "tab-created" || event.type === "tab-updated" || event.type === "tab-closed") {
      this.scheduleRestorePersistence();
    }
  }

  private auditHostRequest(method: BrowserHostMethod, params: unknown, outcome: string): void {
    const body = params && typeof params === "object" ? (params as Record<string, unknown>) : {};
    const session = opaqueAuditId(this.auditKey, body.sessionId);
    const tab = opaqueAuditId(this.auditKey, body.tabId);
    let origin = "none";
    if (typeof body.url === "string") {
      try {
        const parsed = new URL(body.url);
        if (parsed.protocol === "http:" || parsed.protocol === "https:") origin = parsed.origin.slice(0, 512);
      } catch {
        // Invalid URLs are represented by the result code without logging input.
      }
    }
    const revision = Number.isSafeInteger(body.policyRevision) ? String(body.policyRevision) : "none";
    const digest = createHmac("sha256", this.auditKey).update(redactedAuditShape(params)).digest("hex").slice(0, 16);
    appendMainLog(
      `[browser] method=${method} session=${session} tab=${tab} origin=${origin} outcome=${outcome} revision=${revision} input=${digest}`,
    );
  }

  private async defaultConfirmRouteBypass(origin: string): Promise<boolean> {
    const win = this.options.getWindow();
    if (!win || win.isDestroyed()) return false;
    const zh = app.getLocale().toLowerCase().startsWith("zh");
    const response = await dialog.showMessageBox(win, {
      type: "warning",
      title: zh ? "浏览器路径已阻止" : "Browser route blocked",
      message: zh
        ? "浏览器策略阻止该目标后，Agent 正尝试改用其他工具。"
        : "The Agent is trying to use another tool after Browser policy blocked this target.",
      detail: zh
        ? `目标：${origin}\n是否仅允许这一次命令？这不会更改浏览器或网络策略。`
        : `Target: ${origin}\nAllow this one command only? This does not change Browser or network policy.`,
      buttons: zh ? ["取消", "仅允许一次"] : ["Cancel", "Allow once"],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
    });
    return response.response === 1;
  }

  private scheduleRestorePersistence(): void {
    if (this.disposed) return;
    if (this.restoreTimer) clearTimeout(this.restoreTimer);
    this.restoreTimer = setTimeout(() => {
      this.restoreTimer = null;
      this.persistRestoreTabs();
    }, RESTORE_DEBOUNCE_MS);
  }

  private persistRestoreTabs(): void {
    const settings = this.policy.getSettings();
    if (!settings.panel.restoreTabs) return;
    this.restoreStore.write(toBrowserRestoreRecords(this.tabs.list()));
  }

  private getDiagnostics(): BrowserDiagnostics {
    const tabs = this.tabs.list();
    const advanced = this.policy.getSettings().advancedBrowserMode;
    const rendererProcessIds = new Set(this.tabs.getRendererProcessIds());
    const rendererMetrics = app.getAppMetrics().filter((metric) => rendererProcessIds.has(metric.pid));
    const profilePartitions = this.profiles.list().map((profile) => ({
      profileId: profile.id,
      mode: profile.mode,
      partition: this.profiles.getPartition(profile.id),
    }));
    return {
      electronVersion: process.versions.electron ?? "unknown",
      chromiumVersion: process.versions.chrome ?? "unknown",
      activeTabCount: tabs.length,
      activeProfileCount: this.profiles.list().length,
      profilePartitions,
      rendererProcessCount: rendererMetrics.length,
      rendererWorkingSetBytes:
        rendererMetrics.reduce((total, metric) => total + metric.memory.workingSetSize, 0) * 1_024,
      crashedTabCount: tabs.filter((tab) => tab.crashed).length,
      attachedDebuggerCount: this.tabs.countAttachedDebuggers(),
      networkIsolation: this.policy.getSettings().navigation.networkIsolation,
      networkIsolationSummary:
        this.policy.getSettings().navigation.networkIsolation === "strict"
          ? "Unavailable: strict mode requires an enforcing proxy/network sandbox"
          : "Best effort: URL, DNS preflight, redirect, and subresource checks; DNS TOCTOU is not eliminated",
      workflowGuardScope: "obvious-workflow-bypass-only",
      advancedCapabilities: advanced.enabled
        ? [
            "javascript",
            "headers",
            "identity",
            "trusted-input",
            "network-capture",
            "request-replay",
            "snippet-library",
            "site-security-removal",
            "certificate-allowlist",
            "unrestricted-cdp",
          ]
        : [],
      advancedTabCount: countAdvancedProfileTabs(tabs),
      capturedRequestCount: this.tabs.countCapturedRequests(),
      snippetCount: this.snippetStore.count(),
    };
  }

  private async defaultConfirmation(
    kind: BrowserConfirmationKind,
    language: BrowserConfirmationLanguage,
  ): Promise<boolean> {
    const win = this.options.getWindow();
    const copy = confirmationCopy(language);
    const result = await dialog.showMessageBox(win ?? undefined!, {
      type: "warning",
      title: copy.title,
      message: copy.message,
      detail: copy.detail,
      buttons: [copy.cancel, copy.continue],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
    });
    return result.response === 1;
  }

  private async defaultSensitiveActionConfirmation(description: string): Promise<boolean> {
    const result = await dialog.showMessageBox(this.options.getWindow() ?? undefined!, {
      type: "warning",
      title: "Approve Browser action",
      message: description.slice(0, 512),
      detail:
        "The Agent requested an action that may submit data, authorize access, download a file, or change an account.",
      buttons: ["Deny", "Allow once"],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
    });
    return result.response === 1;
  }

  private async openExternalWithConfirmation(url: string): Promise<void> {
    const now = Date.now();
    if (now - (this.recentExternalProtocols.get(url) ?? 0) < 1_000) return;
    this.recentExternalProtocols.set(url, now);
    if (this.recentExternalProtocols.size > 100) {
      const oldest = this.recentExternalProtocols.keys().next().value as string | undefined;
      if (oldest) this.recentExternalProtocols.delete(oldest);
    }
    const pending = this.pendingExternalProtocols.get(url);
    if (pending) return pending;
    const request = this.confirmAndOpenExternal(url).finally(() => this.pendingExternalProtocols.delete(url));
    this.pendingExternalProtocols.set(url, request);
    return request;
  }

  private async confirmAndOpenExternal(url: string): Promise<void> {
    if (!/^mailto:/i.test(url) || url.length > 8_192 || /[\0\r\n]/.test(url)) {
      throw new BrowserError("UNSUPPORTED_PROTOCOL", "External Browser protocol is not allowed");
    }
    const approved =
      (await this.options.confirmExternalProtocol?.(url)) ??
      (
        await dialog.showMessageBox(this.options.getWindow() ?? undefined!, {
          type: "question",
          title: "Open external application?",
          message: "This website requested to open your default mail application.",
          detail: url.slice(0, 512),
          buttons: ["Cancel", "Open"],
          defaultId: 0,
          cancelId: 0,
          noLink: true,
        })
      ).response === 1;
    if (approved) await shell.openExternal(url);
  }

  private async defaultPrivateNetworkConfirmation(url: string): Promise<boolean> {
    const result = await dialog.showMessageBox(this.options.getWindow() ?? undefined!, {
      type: "warning",
      title: "Open private network website?",
      message: "This address points to localhost or a private network.",
      detail: `${new URL(url).origin}\n\nOnly continue if you trust this service. Agent navigation remains blocked unless separately enabled in Browser settings.`,
      buttons: ["Cancel", "Open for this launch"],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
    });
    return result.response === 1;
  }

  private async defaultChooseSavePath(filename: string): Promise<string | null> {
    const result = await dialog.showSaveDialog(this.options.getWindow() ?? undefined!, { defaultPath: filename });
    return result.canceled ? null : (result.filePath ?? null);
  }

  private async defaultChooseUploadPaths(): Promise<string[]> {
    const result = await dialog.showOpenDialog(this.options.getWindow() ?? undefined!, {
      properties: ["openFile", "multiSelections", "dontAddToRecent"],
    });
    return result.canceled ? [] : result.filePaths;
  }
}

function confirmationCopy(language: BrowserConfirmationLanguage) {
  if (language === "zh-CN") {
    return {
      title: "启用高级浏览器模式",
      message:
        "高级浏览器模式会统一开放任意 JavaScript、网络正文与请求重放、身份覆盖、证书放行、同源限制弱化和不受限 CDP。",
      detail: "该模式可能访问登录账号数据并触发第三方风控。仅在理解风险后继续；网页或 Agent 无法开启此模式。",
      cancel: "取消",
      continue: "本次启动启用",
    };
  }
  return {
    title: "Enable Advanced Browser Mode",
    message:
      "Advanced Browser Mode enables arbitrary JavaScript, network bodies and replay, identity overrides, certificate bypass, weakened site security, and unrestricted CDP together.",
    detail:
      "This mode can access signed-in account data and trigger third-party risk controls. A webpage or Agent cannot enable it.",
    cancel: "Cancel",
    continue: "Enable for this launch",
  };
}

function requiredPermission(method: BrowserHostMethod): "read" | "interact" | "advanced" {
  if (
    method === "browser.click" ||
    method === "browser.clickAt" ||
    method === "browser.type" ||
    method === "browser.press" ||
    method === "browser.scroll"
  ) {
    return "interact";
  }
  if (
    method === "browser.executeJavaScript" ||
    method === "browser.getCookies" ||
    method === "browser.setCookies" ||
    method === "browser.setRequestHeaderRules" ||
    method === "browser.setResponseHeaderRules" ||
    method === "browser.sendCdpCommand" ||
    method === "browser.networkList" ||
    method === "browser.networkWait" ||
    method === "browser.networkBody" ||
    method === "browser.networkReplay" ||
    method === "browser.networkSummary" ||
    method === "browser.consoleList" ||
    method === "browser.consoleWait" ||
    method === "browser.pageCodeList" ||
    method === "browser.pageCodeGet"
  ) {
    return "advanced";
  }
  return "read";
}

function previewSnippetResult(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  try {
    const serialized = typeof value === "string" ? value : JSON.stringify(value);
    if (!serialized) return undefined;
    return serialized
      .replace(/\b(?:Bearer\s+)?[A-Za-z0-9+/=_-]{32,}\b/g, "<redacted>")
      .replace(/[\0\r\n]+/g, " ")
      .slice(0, 200);
  } catch {
    return undefined;
  }
}

function assertHeaderDirection(value: string): asserts value is BrowserHeaderRuleDirection {
  if (value !== "request" && value !== "response") {
    throw new BrowserError("INVALID_BROWSER_REQUEST", "Browser header rule direction is invalid");
  }
}

function validateCredentialPart(value: unknown, maxLength: number, label: string, allowEmpty: boolean): string {
  if (
    typeof value !== "string" ||
    (!allowEmpty && value.length === 0) ||
    value.length > maxLength ||
    /[\0\r\n]/.test(value)
  ) {
    throw new BrowserError("INVALID_BROWSER_REQUEST", `Proxy ${label} is invalid`);
  }
  return value;
}

function opaqueAuditId(key: Buffer, value: unknown): string {
  if (typeof value !== "string" || !value) return "none";
  return createHmac("sha256", key).update(value).digest("hex").slice(0, 12);
}

function redactedAuditShape(value: unknown): string {
  const seen = new WeakSet<object>();
  try {
    return (
      JSON.stringify(value, (field, entry: unknown) => {
        if (field === "sessionId" || field === "tabId" || field === "capabilityLeaseId" || field === "requestId") {
          return `<${field}>`;
        }
        if (typeof entry === "bigint") return `<bigint:${entry.toString().length}>`;
        if (entry && typeof entry === "object") {
          if (seen.has(entry)) return "<circular>";
          seen.add(entry);
        }
        return entry;
      }) ?? "undefined"
    );
  } catch {
    return "unserializable";
  }
}
