import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { useI18n } from "@/i18n";
import { browserErrorMessage as messageOf } from "./browser-error-message";
import type {
  BrowserDataType,
  BrowserHeaderRule,
  BrowserHeaderRuleDirection,
  BrowserPageSnippetSummary,
  BrowserPersistentSessionPermission,
  BrowserProfileInfo,
  BrowserRendererState,
  BrowserSettingsPatch,
} from "../../../contract/browser";

export function BrowserSettings({ sessionId }: { sessionId: string | null }) {
  const { language, t } = useI18n();
  const [state, setState] = useState<BrowserRendererState | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [proxyUsername, setProxyUsername] = useState("");
  const [proxyPassword, setProxyPassword] = useState("");
  const [snippets, setSnippets] = useState<BrowserPageSnippetSummary[]>([]);
  const { prompt, requestPrompt, respondToPrompt } = useTextPrompt();

  const refresh = useCallback(async () => {
    try {
      const [nextState, nextSnippets] = await Promise.all([
        window.piBridge.browserGetState(),
        window.piBridge.browserListPageSnippets(),
      ]);
      setState(nextState);
      setSnippets(nextSnippets);
      setError("");
    } catch (cause) {
      setError(messageOf(cause));
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const update = useCallback(
    async (patch: BrowserSettingsPatch) => {
      setBusy(true);
      setError("");
      try {
        const advancedMode = patch.advancedBrowserMode;
        if (advancedMode?.enabled === true && !state?.settings.settings.advancedBrowserMode.enabled) {
          const phrase = await requestPrompt({
            title: t("browserEnableAdvanced", "Enable Advanced Browser Mode"),
            message: t(
              "browserAdvancedPrompt",
              "This enables JavaScript, identity overrides, trusted input, network bodies and write replay, security-header removal, certificate bypass, and unrestricted CDP together. Type ENABLE ADVANCED BROWSER to continue.",
            ),
            requiredValue: "ENABLE ADVANCED BROWSER",
            confirmLabel: t("browserContinue", "Continue"),
          });
          if (phrase === null) return;
          if (phrase !== "ENABLE ADVANCED BROWSER") {
            setError(t("browserAdvancedPromptMismatch", "Advanced Browser confirmation phrase did not match."));
            return;
          }
        }
        const needsConfirmation =
          advancedMode?.enabled === true && !state?.settings.settings.advancedBrowserMode.enabled;
        const proof = needsConfirmation
          ? await window.piBridge.browserRequestConfirmation("advanced-browser-mode", patch, language)
          : undefined;
        if (needsConfirmation && !proof) return;
        await window.piBridge.browserUpdateSettings(patch, proof ?? undefined);
        await refresh();
      } catch (cause) {
        setError(messageOf(cause));
      } finally {
        setBusy(false);
      }
    },
    [language, refresh, requestPrompt, state, t],
  );

  if (!state) {
    return <div style={emptyStyle}>{error || t("browserLoadingSettings", "Loading Browser settings…")}</div>;
  }
  const settings = state.settings.settings;
  const runtime = state.settings.runtime;
  const advancedDisabled = !runtime.advancedBrowserModeEnabled;

  const setAutomationEnabled = async (enabled: boolean) => {
    setBusy(true);
    setError("");
    try {
      await window.piBridge.browserUpdateSettings({ automation: { enabled } });
      await refresh();
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div style={{ width: "100%", overflowY: "auto", padding: "20px clamp(16px, 4vw, 42px) 40px" }}>
        <div style={{ maxWidth: 820, margin: "0 auto", display: "grid", gap: 18, opacity: busy ? 0.72 : 1 }}>
          <div>
            <h2 style={headingStyle}>{t("browserSettingsTitle", "Built-in Browser")}</h2>
            <p style={descriptionStyle}>
              {t(
                "browserSettingsDescription",
                "Websites run in Main-owned, sandboxed Electron WebContentsView instances. Agent access is a separate, default-off permission.",
              )}
            </p>
          </div>
          {error && <div style={errorStyle}>{error}</div>}

          <Section title={t("browserBasics", "Basics")}>
            <Toggle
              label={t("browserEnableBuiltIn", "Enable built-in Browser")}
              checked={settings.enabled}
              onChange={(enabled) => void update({ enabled })}
            />
            <Toggle
              label={t("browserRestoreTabs", "Restore safe tabs on startup")}
              checked={settings.panel.restoreTabs}
              onChange={(restoreTabs) => void update({ panel: { restoreTabs } })}
            />
            <Toggle
              label={t("browserOpenPanelOnUse", "Open Browser panel when Agent starts browsing")}
              checked={settings.panel.openOnAgentUse}
              onChange={(openOnAgentUse) => void update({ panel: { openOnAgentUse } })}
            />
            <Toggle
              label={t("browserUsePersistentProfiles", "Use persistent Profiles by default when creating a Profile")}
              checked={settings.panel.saveLoginState}
              onChange={(saveLoginState) => void update({ panel: { saveLoginState } })}
            />
            <Field label={t("browserDefaultProfile", "Default Profile for new tabs")}>
              <select
                style={inputStyle}
                value={settings.panel.defaultProfileId}
                onChange={(event) => void update({ panel: { defaultProfileId: event.target.value } })}
              >
                {state.profiles
                  .filter((profile) => profile.mode !== "unsafe")
                  .map((profile) => (
                    <option key={profile.id} value={profile.id}>
                      {profile.name} ({profileModeLabel(t, profile.mode)})
                    </option>
                  ))}
              </select>
            </Field>
            <Field label={t("browserHomepage", "Homepage")}>
              <input
                style={inputStyle}
                value={settings.navigation.homepage}
                onChange={(event) => setState(withNavigation(state, { homepage: event.target.value }))}
                onBlur={(event) => void update({ navigation: { homepage: event.target.value } })}
              />
            </Field>
            <div style={gridStyle}>
              <NumberField
                label={t("browserMaximumTabs", "Maximum tabs")}
                value={settings.navigation.maxTabs}
                min={1}
                max={50}
                onCommit={(maxTabs) => void update({ navigation: { maxTabs } })}
              />
              <NumberField
                label={t("browserTabsPerAgent", "Tabs per Agent session")}
                value={settings.navigation.maxTabsPerSession}
                min={1}
                max={20}
                onCommit={(maxTabsPerSession) => void update({ navigation: { maxTabsPerSession } })}
              />
            </div>
            <div style={gridStyle}>
              <NumberField
                label={t("browserNavigationTimeout", "Navigation timeout (ms)")}
                value={settings.navigation.navigationTimeoutMs}
                min={1000}
                max={300000}
                onCommit={(navigationTimeoutMs) => void update({ navigation: { navigationTimeoutMs } })}
              />
              <NumberField
                label={t("browserActionTimeout", "Action timeout (ms)")}
                value={settings.navigation.actionTimeoutMs}
                min={250}
                max={120000}
                onCommit={(actionTimeoutMs) => void update({ navigation: { actionTimeoutMs } })}
              />
            </div>
            <Toggle
              label={t("browserAllowHttp", "Allow plain HTTP")}
              checked={settings.navigation.allowHttp}
              onChange={(allowHttp) => void update({ navigation: { allowHttp } })}
              warning
            />
            <Toggle
              label={t("browserAllowPrivateNetwork", "Allow private network and localhost")}
              checked={settings.navigation.allowPrivateNetwork}
              onChange={(allowPrivateNetwork) => void update({ navigation: { allowPrivateNetwork } })}
              warning
            />
            <Field label={t("browserNetworkIsolation", "Network isolation")}>
              <select
                style={inputStyle}
                value={settings.navigation.networkIsolation}
                onChange={(event) =>
                  void update({
                    navigation: { networkIsolation: event.target.value as "best-effort" | "strict" },
                  })
                }
              >
                <option value="best-effort">{t("browserNetworkBestEffort", "Best effort")}</option>
                <option value="strict">
                  {t("browserNetworkStrict", "Strict (unavailable without enforcing network sandbox)")}
                </option>
              </select>
            </Field>
            <div style={noticeStyle}>
              {settings.navigation.networkIsolation === "strict"
                ? t(
                    "browserNetworkSummaryStrict",
                    "Unavailable: strict mode requires an enforcing proxy or network sandbox.",
                  )
                : t(
                    "browserNetworkSummaryBestEffort",
                    "Best effort: URL checks, DNS preflight, redirects, and subresources; DNS TOCTOU cannot be fully eliminated.",
                  )}
            </div>
          </Section>

          <Section title={t("browserAgentAccess", "Agent access")}>
            <Toggle
              label={t("browserEnableAgentTools", "Enable Browser tools for Agent")}
              checked={settings.automation.enabled}
              onChange={(enabled) => void setAutomationEnabled(enabled)}
            />
            <Field label={t("browserDefaultPermanentPermission", "Default permanent permission")}>
              <select
                style={inputStyle}
                value={settings.automation.defaultPermission}
                onChange={(event) =>
                  void update({
                    automation: {
                      defaultPermission: event.target.value as "ask" | "deny" | "read" | "interact",
                    },
                  })
                }
              >
                <option value="ask">{t("browserPermissionAsk", "Ask for each session")}</option>
                <option value="deny">{t("browserPermissionDeny", "Always deny")}</option>
                <option value="read">{t("browserPermissionReadOnly", "Read only")}</option>
                <option value="interact">{t("browserPermissionAllowInteractions", "Allow interactions")}</option>
              </select>
            </Field>
            <Toggle
              label={t("browserAllowApprovedChannels", "Allow specifically approved channel sessions")}
              checked={settings.automation.allowChannelSessions}
              onChange={(allowChannelSessions) => void update({ automation: { allowChannelSessions } })}
            />
            <Field label={t("browserSensitiveActions", "Sensitive Agent actions")}>
              <select
                style={inputStyle}
                value={settings.automation.sensitiveActions}
                onChange={(event) =>
                  void update({
                    automation: { sensitiveActions: event.target.value as "always-ask" | "deny" },
                  })
                }
              >
                <option value="always-ask">{t("browserAskEveryTime", "Ask every time")}</option>
                <option value="deny">{t("browserDeny", "Deny")}</option>
              </select>
            </Field>
            <Field label={t("browserUserTakeover", "When the user acts while the Agent is working")}>
              <select
                style={inputStyle}
                value={settings.automation.userTakeover}
                onChange={(event) =>
                  void update({
                    automation: {
                      userTakeover: event.target.value as "cancel-agent-action" | "wait",
                    },
                  })
                }
              >
                <option value="cancel-agent-action">
                  {t("browserCancelAgentAction", "Cancel current Agent action")}
                </option>
                <option value="wait">{t("browserWaitForAgent", "Wait for Agent action")}</option>
              </select>
            </Field>
            <Toggle
              label={t("browserHighlightTarget", "Highlight the Agent's target before clicking")}
              checked={settings.automation.showActionHighlight}
              onChange={(showActionHighlight) => void update({ automation: { showActionHighlight } })}
            />
            {sessionId ? (
              <>
                <Field label={t("browserSessionPermanentPermission", "Permanent Browser permission for this session")}>
                  <select
                    style={inputStyle}
                    value={state.persistentSessionPermissions[sessionId] ?? "inherit"}
                    onChange={(event) =>
                      void window.piBridge
                        .browserSetPersistentSessionPermission(
                          sessionId,
                          event.target.value as BrowserPersistentSessionPermission,
                        )
                        .then(refresh)
                        .catch((cause) => setError(messageOf(cause)))
                    }
                  >
                    <option value="inherit">{t("browserPermissionInherit", "Use global default")}</option>
                    <option value="ask">{t("browserPermissionAskSession", "Ask for this session")}</option>
                    <option value="deny">{t("browserPermissionDeny", "Always deny")}</option>
                    <option value="read">{t("browserPermissionRead", "Read")}</option>
                    <option value="interact">{t("browserPermissionInteract", "Interact")}</option>
                    <option value="advanced">{t("browserPermissionAdvanced", "Advanced Browser Mode")}</option>
                  </select>
                </Field>
                <Field label={t("browserCurrentTemporaryPermission", "Current temporary permission")}>
                  <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                    <span style={noticeStyle}>
                      {permissionLabel(
                        t,
                        state.runtimeSessionGrants[sessionId]?.permission ??
                          state.capabilities.sessionPermissions[sessionId] ??
                          "none",
                      )}
                    </span>
                    {state.runtimeSessionGrants[sessionId] && (
                      <button
                        type="button"
                        style={buttonStyle}
                        onClick={() =>
                          void window.piBridge
                            .browserRevokeTemporarySessionPermission(sessionId)
                            .then(refresh)
                            .catch((cause) => setError(messageOf(cause)))
                        }
                      >
                        {t("browserRevokeTemporaryPermission", "Revoke temporary permission")}
                      </button>
                    )}
                  </div>
                </Field>
              </>
            ) : (
              <div style={noticeStyle}>
                {t("browserOpenSavedSession", "Open a saved session to manage its Browser permission.")}
              </div>
            )}
          </Section>

          <Section title={t("browserDownloadsProxy", "Downloads and proxy")}>
            <Field label={t("browserDownloadPolicy", "Download policy")}>
              <select
                style={inputStyle}
                value={settings.downloads.mode}
                onChange={(event) => {
                  const mode = event.target.value as "ask" | "deny" | "allow-to-directory";
                  if (mode !== "allow-to-directory") {
                    void update({ downloads: { mode } });
                    return;
                  }
                  void window.piBridge.selectDirectory().then((directory) => {
                    if (directory) void update({ downloads: { mode, directory } });
                  });
                }}
              >
                <option value="ask">{t("browserAskEveryTime", "Ask every time")}</option>
                <option value="deny">{t("browserDeny", "Deny")}</option>
                <option value="allow-to-directory">
                  {t("browserAllowApprovedDirectory", "Allow to approved directory")}
                </option>
              </select>
            </Field>
            {settings.downloads.mode === "allow-to-directory" && (
              <Field label={t("browserApprovedDirectory", "Approved directory")}>
                <div style={{ display: "flex", gap: 8 }}>
                  <input style={{ ...inputStyle, flex: 1 }} readOnly value={settings.downloads.directory ?? ""} />
                  <button
                    style={buttonStyle}
                    onClick={() =>
                      void window.piBridge.selectDirectory().then((directory) => {
                        if (directory) void update({ downloads: { directory } });
                      })
                    }
                  >
                    {t("browserChoose", "Choose…")}
                  </button>
                </div>
              </Field>
            )}
            <Field label={t("browserProxyMode", "Proxy mode")}>
              <select
                style={inputStyle}
                value={settings.proxy.mode}
                onChange={(event) => {
                  const mode = event.target.value as "system" | "direct" | "custom";
                  void update({
                    proxy: {
                      mode,
                      ...(mode === "custom" && !settings.proxy.proxyRules
                        ? { proxyRules: "http://127.0.0.1:8080" }
                        : {}),
                    },
                  });
                }}
              >
                <option value="system">{t("browserProxySystem", "System")}</option>
                <option value="direct">{t("browserProxyDirect", "Direct")}</option>
                <option value="custom">{t("browserProxyCustom", "Custom")}</option>
              </select>
            </Field>
            {settings.proxy.mode === "custom" && (
              <>
                <Field label={t("browserProxyRules", "Proxy rules")}>
                  <input
                    style={inputStyle}
                    value={settings.proxy.proxyRules ?? ""}
                    onChange={(event) => setState(withProxy(state, { proxyRules: event.target.value }))}
                    onBlur={(event) => void update({ proxy: { proxyRules: event.target.value } })}
                  />
                </Field>
                <Field label={t("browserBypassRules", "Bypass rules")}>
                  <input
                    style={inputStyle}
                    value={settings.proxy.proxyBypassRules ?? ""}
                    onChange={(event) => setState(withProxy(state, { proxyBypassRules: event.target.value }))}
                    onBlur={(event) => void update({ proxy: { proxyBypassRules: event.target.value } })}
                  />
                </Field>
                <div style={gridStyle}>
                  <Field label={t("browserProxyUsername", "Proxy username")}>
                    <input
                      style={inputStyle}
                      autoComplete="off"
                      value={proxyUsername}
                      onChange={(event) => setProxyUsername(event.target.value)}
                    />
                  </Field>
                  <Field label={t("browserProxyPassword", "Proxy password")}>
                    <input
                      style={inputStyle}
                      type="password"
                      autoComplete="new-password"
                      value={proxyPassword}
                      onChange={(event) => setProxyPassword(event.target.value)}
                    />
                  </Field>
                </div>
                <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                  <button
                    style={buttonStyle}
                    disabled={!proxyUsername || !proxyPassword}
                    onClick={() =>
                      void window.piBridge
                        .browserSetProxyCredentials({ username: proxyUsername, password: proxyPassword })
                        .then(() => {
                          setProxyUsername("");
                          setProxyPassword("");
                          return refresh();
                        })
                        .catch((cause) => setError(messageOf(cause)))
                    }
                  >
                    {t("browserStoreCredentials", "Store credentials securely")}
                  </button>
                  {settings.proxy.credentialSecretRef && (
                    <button
                      style={buttonStyle}
                      onClick={() =>
                        void window.piBridge
                          .browserSetProxyCredentials(null)
                          .then(refresh)
                          .catch((cause) => setError(messageOf(cause)))
                      }
                    >
                      {t("browserRemoveCredentials", "Remove stored credentials")}
                    </button>
                  )}
                  <span style={{ color: "var(--text-dim)", fontSize: 11 }}>
                    {settings.proxy.credentialSecretRef
                      ? t("browserCredentialsStored", "Credentials are stored with Electron safeStorage.")
                      : t("browserNoCredentials", "No credentials stored.")}
                  </span>
                </div>
              </>
            )}
          </Section>

          <Section title={t("browserAdvancedMode", "Advanced Browser Mode")}>
            <div style={dangerStyle}>
              {t(
                "browserAdvancedModeWarning",
                "One launch-only switch enables JavaScript, three-layer browser identity, trusted humanized input, full CDP network capture, confirmed write replay, the JavaScript experience library, security-header removal, advanced Profiles, certificate bypass, and unrestricted CDP. Full Cookie values remain blocked by Gate A.",
              )}
            </div>
            <Toggle
              label={t("browserEnableAdvancedForLaunch", "Enable Advanced Browser Mode for this launch")}
              checked={runtime.advancedBrowserModeEnabled}
              onChange={(enabled) => void update({ advancedBrowserMode: { enabled } })}
              danger
            />
            <div style={noticeStyle}>
              {t(
                "browserAdvancedRuntimeConfirmations",
                "POST/PUT/PATCH/DELETE replay and existing sensitive actions still require one local confirmation per action; these are action confirmations, not extra settings.",
              )}
            </div>
            <Field label={t("browserIdentityMode", "Browser identity")}>
              <select
                style={inputStyle}
                value={settings.advancedBrowserMode.identityMode}
                onChange={(event) =>
                  void update({
                    advancedBrowserMode: {
                      identityMode: event.target.value as "native" | "chrome-compatible" | "custom",
                    },
                  })
                }
              >
                <option value="chrome-compatible">
                  {t("browserIdentityChromeCompatible", "Chromium-compatible (recommended)")}
                </option>
                <option value="native">{t("browserIdentityNative", "Electron native")}</option>
                <option value="custom">{t("browserIdentityCustom", "Custom consistent identity")}</option>
              </select>
            </Field>
            {settings.advancedBrowserMode.identityMode === "custom" && (
              <>
                <Field label={t("browserCustomUserAgent", "Custom User-Agent")}>
                  <input
                    style={inputStyle}
                    value={settings.advancedBrowserMode.customUserAgentValue}
                    onChange={(event) =>
                      setState(withAdvancedMode(state, { customUserAgentValue: event.target.value }))
                    }
                    onBlur={(event) =>
                      void update({ advancedBrowserMode: { customUserAgentValue: event.target.value } })
                    }
                    placeholder="Mozilla/5.0 … Chrome/142.0.0.0 …"
                  />
                </Field>
                <Field label={t("browserClientHintsPlatform", "Client Hints platform")}>
                  <input
                    style={inputStyle}
                    value={settings.advancedBrowserMode.customUserAgentPlatform}
                    onChange={(event) =>
                      setState(withAdvancedMode(state, { customUserAgentPlatform: event.target.value }))
                    }
                    onBlur={(event) =>
                      void update({ advancedBrowserMode: { customUserAgentPlatform: event.target.value } })
                    }
                    placeholder="macOS, Windows, Linux…"
                  />
                </Field>
                <Field label={t("browserChromiumFullVersion", "Chromium full version")}>
                  <input
                    style={inputStyle}
                    value={settings.advancedBrowserMode.customUserAgentFullVersion}
                    onChange={(event) =>
                      setState(withAdvancedMode(state, { customUserAgentFullVersion: event.target.value }))
                    }
                    onBlur={(event) =>
                      void update({ advancedBrowserMode: { customUserAgentFullVersion: event.target.value } })
                    }
                    placeholder="142.0.0.0"
                  />
                </Field>
              </>
            )}
            <Field label={t("browserCertificateDomains", "Certificate bypass domains (comma separated)")}>
              <input
                style={inputStyle}
                value={settings.advancedBrowserMode.certificateBypassDomains.join(", ")}
                onChange={(event) =>
                  setState(
                    withAdvancedMode(state, {
                      certificateBypassDomains: event.target.value.split(",").map((value) => value.trim()),
                    }),
                  )
                }
                onBlur={(event) =>
                  void update({
                    advancedBrowserMode: {
                      certificateBypassDomains: event.target.value
                        .split(",")
                        .map((value) => value.trim())
                        .filter(Boolean),
                    },
                  })
                }
              />
            </Field>
            <NumberField
              label={t("browserNetworkRequestCapacity", "Captured requests per tab")}
              value={settings.advancedBrowserMode.maxRequestsPerTab}
              min={50}
              max={5000}
              onCommit={(maxRequestsPerTab) => void update({ advancedBrowserMode: { maxRequestsPerTab } })}
            />
            <NumberField
              label={t("browserNetworkBodyCapacity", "Captured body capacity per tab (MiB)")}
              value={Math.round(settings.advancedBrowserMode.maxBodyBytesPerTab / (1024 * 1024))}
              min={1}
              max={256}
              onCommit={(value) => void update({ advancedBrowserMode: { maxBodyBytesPerTab: value * 1024 * 1024 } })}
            />
            <NumberField
              label={t("browserSnippetCapacity", "JavaScript experiences per host")}
              value={settings.advancedBrowserMode.maxPerHost}
              min={5}
              max={200}
              onCommit={(maxPerHost) => void update({ advancedBrowserMode: { maxPerHost } })}
            />
          </Section>

          <HeaderRulesSection
            profiles={state.profiles.filter(
              (profile) => profile.mode !== "unsafe" || runtime.advancedBrowserModeEnabled,
            )}
            disabled={advancedDisabled}
            requestEnabled={runtime.advancedBrowserModeEnabled}
            responseEnabled={runtime.advancedBrowserModeEnabled}
            setError={setError}
          />

          <SnippetSection snippets={snippets} refresh={refresh} setError={setError} />

          <ProfileSection
            profiles={state.profiles}
            advancedModeEnabled={runtime.advancedBrowserModeEnabled}
            saveLoginState={settings.panel.saveLoginState}
            refresh={refresh}
            setError={setError}
          />

          <Section title={t("browserDiagnosticsReset", "Diagnostics and reset")}>
            <div style={{ ...gridStyle, fontSize: 12, color: "var(--text-muted)" }}>
              <span>Electron {state.diagnostics.electronVersion}</span>
              <span>Chromium {state.diagnostics.chromiumVersion}</span>
              <span>
                {formatMessage(t("browserTabsCount", "{count} tabs"), { count: state.diagnostics.activeTabCount })}
              </span>
              <span>
                {formatMessage(t("browserCdpConnections", "{count} CDP connections"), {
                  count: state.diagnostics.attachedDebuggerCount,
                })}
              </span>
              <span>
                {formatMessage(t("browserCrashedTabs", "{count} crashed tabs"), {
                  count: state.diagnostics.crashedTabCount,
                })}
              </span>
              <span>
                {formatMessage(t("browserAdvancedTabs", "{count} advanced tabs"), {
                  count: state.diagnostics.advancedTabCount,
                })}
              </span>
              <span>
                {formatMessage(t("browserCapturedRequests", "{count} captured requests"), {
                  count: state.diagnostics.capturedRequestCount,
                })}
              </span>
              <span>
                {formatMessage(t("browserJavascriptExperiences", "{count} JavaScript experiences"), {
                  count: state.diagnostics.snippetCount,
                })}
              </span>
              <span>
                {formatMessage(t("browserRendererProcesses", "{count} renderer processes"), {
                  count: state.diagnostics.rendererProcessCount,
                })}
              </span>
              <span>
                {formatMessage(t("browserRendererWorkingSet", "Renderer working set {size}"), {
                  size: formatBytes(state.diagnostics.rendererWorkingSetBytes),
                })}
              </span>
            </div>
            <div style={noticeStyle}>
              {state.diagnostics.profilePartitions
                .map((profile) => `${profileModeLabel(t, profile.mode)}: ${profile.partition}`)
                .join(" · ")}
            </div>
            <div style={noticeStyle}>
              {t(
                "browserWorkflowGuardScope",
                "Workflow guard blocks obvious Browser route bypasses; it is not an OS network sandbox.",
              )}
            </div>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              <button
                style={buttonStyle}
                onClick={() =>
                  void Promise.all(
                    state.profiles.map((profile) => window.piBridge.browserClearProfileData(profile.id, "all")),
                  )
                    .then(refresh)
                    .catch((cause) => setError(messageOf(cause)))
                }
              >
                {t("browserClearAllData", "Clear all browser data")}
              </button>
              <button style={buttonStyle} onClick={() => void window.piBridge.exportDiagnostics()}>
                {t("browserExportDiagnostics", "Export redacted diagnostics")}
              </button>
              <button style={buttonStyle} onClick={() => void window.piBridge.browserCloseAllTabs().then(refresh)}>
                {t("browserCloseAllTabs", "Close all tabs")}
              </button>
              <button
                style={{ ...buttonStyle, color: "#c43" }}
                onClick={() => {
                  if (
                    window.confirm(
                      t("browserResetConfirm", "Reset Browser settings and revoke all Browser capabilities?"),
                    )
                  ) {
                    void window.piBridge
                      .browserReset()
                      .then(setState)
                      .catch((cause) => setError(messageOf(cause)));
                  }
                }}
              >
                {t("browserReset", "Reset Browser")}
              </button>
            </div>
          </Section>
        </div>
      </div>
      {prompt && <TextPromptDialog prompt={prompt} cancelLabel={t("cancel", "Cancel")} onRespond={respondToPrompt} />}
    </>
  );
}

function HeaderRulesSection({
  profiles,
  disabled,
  requestEnabled,
  responseEnabled,
  setError,
}: {
  profiles: BrowserProfileInfo[];
  disabled: boolean;
  requestEnabled: boolean;
  responseEnabled: boolean;
  setError: (value: string) => void;
}) {
  const { t } = useI18n();
  const [profileId, setProfileId] = useState(profiles[0]?.id ?? "temporary");
  const [direction, setDirection] = useState<BrowserHeaderRuleDirection>("request");
  const [rules, setRules] = useState<BrowserHeaderRule[]>([]);
  const [urlPattern, setUrlPattern] = useState("https://example.com/*");
  const [resourceTypes, setResourceTypes] = useState("");
  const [header, setHeader] = useState("x-pi-browser");
  const [operation, setOperation] = useState<BrowserHeaderRule["operation"]>("set");
  const [value, setValue] = useState("");
  const [storeSecurely, setStoreSecurely] = useState(false);
  const directionEnabled = direction === "request" ? requestEnabled : responseEnabled;

  const load = useCallback(async () => {
    if (!profileId) return;
    try {
      setRules(await window.piBridge.browserGetHeaderRules(profileId, direction));
    } catch (cause) {
      setError(messageOf(cause));
    }
  }, [direction, profileId, setError]);

  useEffect(() => {
    if (!profiles.some((profile) => profile.id === profileId)) setProfileId(profiles[0]?.id ?? "temporary");
  }, [profileId, profiles]);

  useEffect(() => {
    void load();
  }, [load]);

  const save = async (next: BrowserHeaderRule[]) => {
    try {
      await window.piBridge.browserSetHeaderRules(profileId, direction, next);
      setRules(next);
      setError("");
    } catch (cause) {
      setError(messageOf(cause));
    }
  };

  const add = async () => {
    try {
      const normalizedHeader = header.trim().toLowerCase();
      const mustStoreSecurely = storeSecurely || normalizedHeader === "authorization";
      const secretRef =
        operation !== "remove" && mustStoreSecurely ? await window.piBridge.browserStoreHeaderSecret(value) : undefined;
      const rule: BrowserHeaderRule = {
        id: `rule-${Date.now().toString(36)}`,
        enabled: true,
        profileId,
        urlPattern: urlPattern.trim(),
        ...(resourceTypes.trim()
          ? {
              resourceTypes: resourceTypes
                .split(",")
                .map((entry) => entry.trim())
                .filter(Boolean),
            }
          : {}),
        header: normalizedHeader,
        operation,
        ...(operation === "remove" ? {} : secretRef ? { secretRef } : { value }),
      };
      await window.piBridge.browserSetHeaderRules(profileId, direction, [...rules, rule]);
      setRules([...rules, rule]);
      setValue("");
      setStoreSecurely(false);
      setError("");
    } catch (cause) {
      setError(messageOf(cause));
    }
  };

  return (
    <Section title={t("browserHeaderRules", "Advanced header rules")}>
      <div style={noticeStyle}>
        {t(
          "browserHeaderRulesDescription",
          "Rules are scoped to a Profile, URL pattern, and optional Chromium resource types. Secret values are write-only and stored with Electron safeStorage.",
        )}
      </div>
      <div style={gridStyle}>
        <Field label={t("browserProfile", "Profile")}>
          <select style={inputStyle} value={profileId} onChange={(event) => setProfileId(event.target.value)}>
            {profiles.map((profile) => (
              <option key={profile.id} value={profile.id}>
                {profile.name} ({profileModeLabel(t, profile.mode)})
              </option>
            ))}
          </select>
        </Field>
        <Field label={t("browserDirection", "Direction")}>
          <select
            style={inputStyle}
            value={direction}
            onChange={(event) => setDirection(event.target.value as BrowserHeaderRuleDirection)}
          >
            <option value="request">{t("browserRequest", "Request")}</option>
            <option value="response">{t("browserResponse", "Response")}</option>
          </select>
        </Field>
      </div>
      {(!directionEnabled || disabled) && (
        <div style={warningStyle}>
          {t(
            "browserEnableHeaderCapability",
            "Enable the matching Advanced header override capability before editing these rules.",
          )}
        </div>
      )}
      <div style={{ display: "grid", gap: 7 }}>
        {rules.map((rule) => (
          <div
            key={rule.id}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              padding: 8,
              border: "1px solid var(--border)",
              borderRadius: 6,
            }}
          >
            <input
              type="checkbox"
              checked={rule.enabled}
              disabled={disabled || !directionEnabled}
              onChange={(event) =>
                void save(
                  rules.map((candidate) =>
                    candidate.id === rule.id ? { ...candidate, enabled: event.target.checked } : candidate,
                  ),
                )
              }
              aria-label={formatMessage(t("browserEnableRule", "Enable {header} rule"), { header: rule.header })}
            />
            <div style={{ flex: 1, minWidth: 0, fontSize: 11, color: "var(--text-muted)" }}>
              <div style={{ color: "var(--text)" }}>
                {headerOperationLabel(t, rule.operation)} {rule.header}{" "}
                {rule.secretRef ? t("browserSecureValue", "(secure value)") : (rule.value ?? "")}
              </div>
              <div style={{ overflow: "hidden", textOverflow: "ellipsis" }}>{rule.urlPattern}</div>
            </div>
            <button
              style={smallButtonStyle}
              disabled={disabled || !directionEnabled}
              onClick={() =>
                void (async () => {
                  if (rule.secretRef) await window.piBridge.browserRemoveHeaderSecret(rule.secretRef);
                  await save(rules.filter((candidate) => candidate.id !== rule.id));
                })()
              }
            >
              {t("browserDelete", "Delete")}
            </button>
          </div>
        ))}
      </div>
      <div style={gridStyle}>
        <Field label={t("browserUrlPattern", "URL pattern")}>
          <input style={inputStyle} value={urlPattern} onChange={(event) => setUrlPattern(event.target.value)} />
        </Field>
        <Field label={t("browserResourceTypes", "Resource types (optional, comma separated)")}>
          <input style={inputStyle} value={resourceTypes} onChange={(event) => setResourceTypes(event.target.value)} />
        </Field>
        <Field label={t("browserHeader", "Header")}>
          <input style={inputStyle} value={header} onChange={(event) => setHeader(event.target.value)} />
        </Field>
        <Field label={t("browserOperation", "Operation")}>
          <select
            style={inputStyle}
            value={operation}
            onChange={(event) => setOperation(event.target.value as BrowserHeaderRule["operation"])}
          >
            <option value="set">{t("browserOperationSet", "Set")}</option>
            <option value="append">{t("browserOperationAppend", "Append")}</option>
            <option value="remove">{t("browserOperationRemove", "Remove")}</option>
          </select>
        </Field>
      </div>
      {operation !== "remove" && (
        <>
          <Field label={t("browserHeaderValue", "Value (never reloaded when stored securely)")}>
            <input
              style={inputStyle}
              type={storeSecurely || header.trim().toLowerCase() === "authorization" ? "password" : "text"}
              autoComplete="off"
              value={value}
              onChange={(event) => setValue(event.target.value)}
            />
          </Field>
          <Toggle
            label={t("browserStoreValueSecurely", "Store this value securely")}
            checked={storeSecurely || header.trim().toLowerCase() === "authorization"}
            disabled={header.trim().toLowerCase() === "authorization"}
            onChange={setStoreSecurely}
            warning
          />
        </>
      )}
      <button
        style={buttonStyle}
        disabled={
          disabled ||
          !directionEnabled ||
          !profileId ||
          !urlPattern.trim() ||
          !header.trim() ||
          (operation !== "remove" && !value)
        }
        onClick={() => void add()}
      >
        {t("browserAddHeaderRule", "Add header rule")}
      </button>
    </Section>
  );
}

function SnippetSection({
  snippets,
  refresh,
  setError,
}: {
  snippets: BrowserPageSnippetSummary[];
  refresh: () => Promise<void>;
  setError: (value: string) => void;
}) {
  const { t } = useI18n();
  return (
    <Section title={t("browserJavascriptExperience", "JavaScript experience library")}>
      <div style={noticeStyle}>
        {t(
          "browserJavascriptExperienceNotice",
          "Only successful scripts saved with remember=true and an explicit purpose appear here. Saved code is never executed automatically.",
        )}
      </div>
      {snippets.length === 0 ? (
        <div style={{ color: "var(--text-dim)", fontSize: 12 }}>
          {t("browserNoJavascriptExperience", "No saved JavaScript experiences.")}
        </div>
      ) : (
        <div style={{ display: "grid", gap: 8 }}>
          {snippets.map((snippet) => (
            <div
              key={snippet.id}
              style={{
                display: "flex",
                gap: 8,
                alignItems: "center",
                padding: 10,
                border: "1px solid var(--border)",
                borderRadius: 7,
              }}
            >
              <div style={{ flex: 1, minWidth: 0 }}>
                <div
                  style={{
                    color: snippet.enabled ? "var(--text)" : "var(--text-dim)",
                    fontSize: 12,
                    fontWeight: 650,
                  }}
                >
                  {snippet.label}
                </div>
                <div style={{ color: "var(--text-dim)", fontSize: 11 }}>
                  {snippet.host}
                  {formatMessage(t("browserJavascriptExperienceUsage", "{path} · {size} · used {count} times"), {
                    path: snippet.pathPattern,
                    size: formatBytes(snippet.codeBytes),
                    count: snippet.useCount,
                  })}
                </div>
              </div>
              <button
                style={smallButtonStyle}
                onClick={() =>
                  void window.piBridge
                    .browserSetPageSnippetEnabled(snippet.id, !snippet.enabled)
                    .then(refresh)
                    .catch((cause) => setError(messageOf(cause)))
                }
              >
                {snippet.enabled ? t("browserDisable", "Disable") : t("browserEnable", "Enable")}
              </button>
              <button
                style={smallButtonStyle}
                onClick={() =>
                  void window.piBridge
                    .browserDeletePageSnippet(snippet.id)
                    .then(refresh)
                    .catch((cause) => setError(messageOf(cause)))
                }
              >
                {t("browserDelete", "Delete")}
              </button>
            </div>
          ))}
        </div>
      )}
      <button
        style={buttonStyle}
        disabled={snippets.length === 0}
        onClick={() =>
          void window.piBridge
            .browserClearPageSnippets()
            .then(refresh)
            .catch((cause) => setError(messageOf(cause)))
        }
      >
        {t("browserClearJavascriptExperience", "Clear JavaScript experiences")}
      </button>
    </Section>
  );
}

function ProfileSection({
  profiles,
  advancedModeEnabled,
  saveLoginState,
  refresh,
  setError,
}: {
  profiles: BrowserProfileInfo[];
  advancedModeEnabled: boolean;
  saveLoginState: boolean;
  refresh: () => Promise<void>;
  setError: (value: string) => void;
}) {
  const { t } = useI18n();
  const { prompt, requestPrompt, respondToPrompt } = useTextPrompt();
  const create = async (mode: BrowserProfileInfo["mode"]) => {
    const name = await requestPrompt({
      title: t("browserNewProfileTitle", "Create Browser Profile"),
      message: t("browserProfileName", "Profile name"),
      confirmLabel: t("browserCreate", "Create"),
    });
    if (!name) return;
    try {
      await window.piBridge.browserCreateProfile({ name, mode });
      await refresh();
    } catch (cause) {
      setError(messageOf(cause));
    }
  };
  const clear = async (profileId: string, dataType: BrowserDataType) => {
    try {
      await window.piBridge.browserClearProfileData(profileId, dataType);
      await refresh();
    } catch (cause) {
      setError(messageOf(cause));
    }
  };
  const rename = async (profile: BrowserProfileInfo) => {
    const name = await requestPrompt({
      title: t("browserRenameProfileTitle", "Rename Browser Profile"),
      message: t("browserNewProfileName", "New Profile name"),
      defaultValue: profile.name,
      confirmLabel: t("rename", "Rename"),
    });
    if (!name || name === profile.name) return;
    try {
      await window.piBridge.browserRenameProfile(profile.id, name);
      await refresh();
    } catch (cause) {
      setError(messageOf(cause));
    }
  };
  return (
    <>
      <Section title={t("browserProfilesData", "Profiles and site data")}>
        <div style={{ display: "grid", gap: 8 }}>
          {profiles.map((profile) => (
            <div
              key={profile.id}
              style={{
                display: "flex",
                gap: 8,
                alignItems: "center",
                padding: 10,
                border: "1px solid var(--border)",
                borderRadius: 7,
              }}
            >
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ color: "var(--text)", fontSize: 12, fontWeight: 650 }}>{profile.name}</div>
                <div style={{ color: "var(--text-dim)", fontSize: 11 }}>
                  {profileModeLabel(t, profile.mode)} · {t("browserProxyMode", "Proxy mode")}{" "}
                  {proxyModeLabel(t, profile.proxyMode)}
                </div>
              </div>
              <button style={smallButtonStyle} onClick={() => void clear(profile.id, "all")}>
                {t("browserClearData", "Clear data")}
              </button>
              {profile.id !== "temporary" && (
                <>
                  <button style={smallButtonStyle} onClick={() => void rename(profile)}>
                    {t("browserRename", "Rename")}
                  </button>
                  <button
                    style={smallButtonStyle}
                    onClick={() => {
                      if (
                        window.confirm(
                          formatMessage(t("browserDeleteProfileConfirm", "Delete Browser Profile “{name}”?"), {
                            name: profile.name,
                          }),
                        )
                      ) {
                        void window.piBridge
                          .browserDeleteProfile(profile.id)
                          .then(refresh)
                          .catch((cause) => setError(messageOf(cause)));
                      }
                    }}
                  >
                    {t("browserDelete", "Delete")}
                  </button>
                </>
              )}
            </div>
          ))}
        </div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <button style={buttonStyle} onClick={() => void create(saveLoginState ? "persistent" : "ephemeral")}>
            {formatMessage(t("browserNewProfile", "New Profile ({mode})"), {
              mode: saveLoginState ? profileModeLabel(t, "persistent") : t("browserModeEphemeral", "temporary"),
            })}
          </button>
          <button style={buttonStyle} disabled={!advancedModeEnabled} onClick={() => void create("unsafe")}>
            {t("browserNewAdvancedProfile", "New advanced Profile")}
          </button>
        </div>
      </Section>
      {prompt && <TextPromptDialog prompt={prompt} cancelLabel={t("cancel", "Cancel")} onRespond={respondToPrompt} />}
    </>
  );
}

type TextPromptOptions = {
  title: string;
  message: string;
  defaultValue?: string;
  requiredValue?: string;
  confirmLabel: string;
};

function useTextPrompt() {
  const [prompt, setPrompt] = useState<TextPromptOptions | null>(null);
  const resolverRef = useRef<((value: string | null) => void) | null>(null);

  const requestPrompt = useCallback((nextPrompt: TextPromptOptions) => {
    return new Promise<string | null>((resolve) => {
      resolverRef.current?.(null);
      resolverRef.current = resolve;
      setPrompt(nextPrompt);
    });
  }, []);

  const respondToPrompt = useCallback((value: string | null) => {
    const resolve = resolverRef.current;
    resolverRef.current = null;
    setPrompt(null);
    resolve?.(value);
  }, []);

  useEffect(
    () => () => {
      const resolve = resolverRef.current;
      resolverRef.current = null;
      resolve?.(null);
    },
    [],
  );

  return { prompt, requestPrompt, respondToPrompt };
}

function TextPromptDialog({
  prompt,
  cancelLabel,
  onRespond,
}: {
  prompt: TextPromptOptions;
  cancelLabel: string;
  onRespond: (value: string | null) => void;
}) {
  const [value, setValue] = useState(prompt.defaultValue ?? "");
  const inputRef = useRef<HTMLInputElement>(null);
  const dialogRef = useRef<HTMLFormElement>(null);
  const canSubmit = value.trim().length > 0 && (!prompt.requiredValue || value === prompt.requiredValue);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  return (
    <div
      role="presentation"
      style={promptBackdropStyle}
      onClick={(event) => {
        if (event.target === event.currentTarget) onRespond(null);
      }}
    >
      <form
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="browser-text-prompt-title"
        style={promptDialogStyle}
        onSubmit={(event) => {
          event.preventDefault();
          if (canSubmit) onRespond(value);
        }}
        onKeyDown={(event) => {
          event.stopPropagation();
          if (event.key === "Escape") {
            event.preventDefault();
            onRespond(null);
            return;
          }
          if (event.key !== "Tab") return;
          const dialog = dialogRef.current;
          if (!dialog) return;
          const focusable = Array.from(
            dialog.querySelectorAll<HTMLElement>(
              'button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])',
            ),
          );
          const first = focusable[0];
          const last = focusable[focusable.length - 1];
          if (!first || !last) return;
          if (event.shiftKey && document.activeElement === first) {
            event.preventDefault();
            last.focus();
          } else if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault();
            first.focus();
          }
        }}
      >
        <div id="browser-text-prompt-title" style={{ color: "var(--text)", fontSize: 14, fontWeight: 650 }}>
          {prompt.title}
        </div>
        <div style={{ color: "var(--text-muted)", fontSize: 12, lineHeight: 1.6 }}>{prompt.message}</div>
        {prompt.requiredValue && <code style={confirmationPhraseStyle}>{prompt.requiredValue}</code>}
        <input
          ref={inputRef}
          style={inputStyle}
          aria-label={prompt.message}
          autoComplete="off"
          spellCheck={false}
          value={value}
          onChange={(event) => setValue(event.target.value)}
        />
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
          <button type="button" style={buttonStyle} onClick={() => onRespond(null)}>
            {cancelLabel}
          </button>
          <button type="submit" style={primaryButtonStyle} disabled={!canSubmit}>
            {prompt.confirmLabel}
          </button>
        </div>
      </form>
    </div>
  );
}

type Translate = ReturnType<typeof useI18n>["t"];

function formatMessage(template: string, values: Record<string, string | number>): string {
  return Object.entries(values).reduce(
    (message, [key, value]) => message.replaceAll(`{${key}}`, String(value)),
    template,
  );
}

function profileModeLabel(t: Translate, mode: BrowserProfileInfo["mode"]): string {
  switch (mode) {
    case "persistent":
      return t("browserModePersistent", "persistent");
    case "unsafe":
      return t("browserModeAdvanced", "advanced");
    default:
      return t("browserModeEphemeral", "temporary");
  }
}

function permissionLabel(t: Translate, permission: "none" | "read" | "interact" | "advanced"): string {
  switch (permission) {
    case "read":
      return t("browserPermissionRead", "Read");
    case "interact":
      return t("browserPermissionInteract", "Interact");
    case "advanced":
      return t("browserPermissionAdvanced", "Advanced Browser Mode");
    default:
      return t("browserPermissionNone", "None");
  }
}

function proxyModeLabel(t: Translate, mode: BrowserProfileInfo["proxyMode"]): string {
  switch (mode) {
    case "direct":
      return t("browserProxyDirect", "Direct");
    case "custom":
      return t("browserProxyCustom", "Custom");
    default:
      return t("browserProxySystem", "System");
  }
}

function headerOperationLabel(t: Translate, operation: BrowserHeaderRule["operation"]): string {
  switch (operation) {
    case "append":
      return t("browserOperationAppend", "Append");
    case "remove":
      return t("browserOperationRemove", "Remove");
    default:
      return t("browserOperationSet", "Set");
  }
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section
      style={{
        display: "grid",
        gap: 12,
        border: "1px solid var(--border)",
        borderRadius: 9,
        padding: 16,
        background: "var(--bg-panel)",
      }}
    >
      <h3 style={{ margin: 0, fontSize: 13, color: "var(--text)" }}>{title}</h3>
      {children}
    </section>
  );
}

function Toggle({
  label,
  checked,
  disabled,
  onChange,
  warning,
  danger,
}: {
  label: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (checked: boolean) => void;
  warning?: boolean;
  danger?: boolean;
}) {
  return (
    <label
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: 12,
        color: danger ? "#d45" : warning ? "#b87924" : "var(--text-muted)",
        fontSize: 12,
      }}
    >
      <span>{label}</span>
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
      />
    </label>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label style={{ display: "grid", gap: 6, color: "var(--text-muted)", fontSize: 11 }}>
      <span>{label}</span>
      {children}
    </label>
  );
}

function NumberField({
  label,
  value,
  min,
  max,
  onCommit,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  onCommit: (value: number) => void;
}) {
  return (
    <Field label={label}>
      <input
        style={inputStyle}
        type="number"
        min={min}
        max={max}
        defaultValue={value}
        onBlur={(event) => onCommit(Number(event.target.value))}
      />
    </Field>
  );
}

function withNavigation(
  state: BrowserRendererState,
  patch: Partial<BrowserRendererState["settings"]["settings"]["navigation"]>,
): BrowserRendererState {
  return {
    ...state,
    settings: {
      ...state.settings,
      settings: { ...state.settings.settings, navigation: { ...state.settings.settings.navigation, ...patch } },
    },
  };
}

function withProxy(
  state: BrowserRendererState,
  patch: Partial<BrowserRendererState["settings"]["settings"]["proxy"]>,
): BrowserRendererState {
  return {
    ...state,
    settings: {
      ...state.settings,
      settings: { ...state.settings.settings, proxy: { ...state.settings.settings.proxy, ...patch } },
    },
  };
}

function withAdvancedMode(
  state: BrowserRendererState,
  patch: Partial<BrowserRendererState["settings"]["settings"]["advancedBrowserMode"]>,
): BrowserRendererState {
  return {
    ...state,
    settings: {
      ...state.settings,
      settings: {
        ...state.settings.settings,
        advancedBrowserMode: { ...state.settings.settings.advancedBrowserMode, ...patch },
      },
    },
  };
}

function formatBytes(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "0 B";
  if (value < 1_024 * 1_024) return `${Math.round(value / 1_024)} KiB`;
  return `${(value / (1_024 * 1_024)).toFixed(1)} MiB`;
}

const headingStyle = { margin: 0, color: "var(--text)", fontSize: 18 };
const descriptionStyle = { margin: "6px 0 0", color: "var(--text-dim)", fontSize: 12, lineHeight: 1.6 };
const emptyStyle = { margin: "auto", color: "var(--text-muted)", fontSize: 12 };
const inputStyle = {
  width: "100%",
  minHeight: 34,
  boxSizing: "border-box" as const,
  border: "1px solid var(--border)",
  borderRadius: 6,
  padding: "6px 9px",
  background: "var(--bg)",
  color: "var(--text)",
  fontSize: 12,
};
const buttonStyle = {
  minHeight: 32,
  border: "1px solid var(--border)",
  borderRadius: 6,
  padding: "0 11px",
  background: "var(--bg)",
  color: "var(--text-muted)",
  cursor: "pointer",
  fontSize: 11,
};
const primaryButtonStyle = {
  ...buttonStyle,
  borderColor: "var(--accent)",
  background: "var(--accent)",
  color: "var(--accent-contrast)",
};
const smallButtonStyle = { ...buttonStyle, minHeight: 27, padding: "0 8px" };
const promptBackdropStyle = {
  position: "fixed" as const,
  inset: 0,
  zIndex: 1100,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  padding: 20,
  background: "rgba(0,0,0,0.38)",
};
const promptDialogStyle = {
  width: "min(480px, 100%)",
  display: "grid",
  gap: 13,
  padding: 18,
  border: "1px solid var(--border)",
  borderRadius: 9,
  background: "var(--bg-panel)",
  boxShadow: "0 20px 60px rgba(0,0,0,0.28)",
};
const confirmationPhraseStyle = {
  display: "block",
  width: "fit-content",
  padding: "5px 7px",
  borderRadius: 5,
  background: "var(--bg)",
  color: "var(--text)",
  fontSize: 11,
  userSelect: "all" as const,
};
const gridStyle = { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 10 };
const noticeStyle = {
  padding: 9,
  borderRadius: 6,
  background: "var(--bg)",
  color: "var(--text-dim)",
  fontSize: 11,
  lineHeight: 1.5,
};
const warningStyle = {
  ...noticeStyle,
  color: "#b87924",
  border: "1px solid color-mix(in srgb, #b87924 35%, transparent)",
};
const dangerStyle = { ...noticeStyle, color: "#d45", border: "1px solid color-mix(in srgb, #d45 45%, transparent)" };
const errorStyle = { ...noticeStyle, color: "#d45", border: "1px solid color-mix(in srgb, #d45 35%, transparent)" };
