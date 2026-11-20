import {
  updateStatusColor,
  displayVersion,
  formatUpdateDate,
  formatBytes,
  updateDetailStyle,
} from "@/lib/update-display";
import { Select } from "@/components/ui/Select";
import { Checkbox } from "@/components/ui/Checkbox";
import { Dialog } from "@/components/ui/Dialog";
import { StatusDot } from "@/components/ui/StatusDot";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { useTheme } from "@/hooks/useTheme";
import { useIsMobile } from "@/hooks/useIsMobile";
import { useI18n, type AppLanguage } from "@/i18n";
import { ModelsConfig } from "./ModelsConfig";
import { SkillsConfig, type SkillsConfigHandle } from "./SkillsConfig";
import { PluginsConfig } from "./PluginsConfig";
import { ToolchainsConfig } from "./ToolchainsSettings";
import { WindowsAgentShellSetting } from "./AgentShellSetting";
import { DefaultToolPresetSetting } from "./settings/DefaultToolPresetSetting";
import { BrowserSettings } from "./browser/BrowserSettings";
import { ChannelsConfig } from "./channels/ChannelsConfig";
import type { ChannelsSnapshot } from "@shared/channel-types";
import type { ChatAppearancePreferences, ChatAssistantWidth, ChatFontSize, ChatLayout } from "@shared/chat-appearance";
import { APP_WEBSITE_URL } from "@shared/app-links";
import type { DesktopUpdateState } from "../../contract/desktop";
import type { ManagedProcessCapability } from "../../contract/processes";
import {
  APP_AUTHOR,
  APP_DISPLAY_NAME,
  APP_FORK_AUTHOR,
  APP_GITHUB_URL,
  APP_VERSION,
  PI_VERSION,
} from "@/lib/app-version";
import appIconUrl from "../../../build/icon.png";
import { isAutoSessionTitleEnabled, setAutoSessionTitleEnabled } from "../lib/auto-session-title";
import { HerdrSettings } from "./herdr/HerdrSettings";
import { SettingRow } from "./settings/settings-controls";
import { CacheWarmingSettings } from "./settings/CacheWarmingSettings";
import { DefaultThinkingLevelSettings } from "./settings/DefaultThinkingLevelSettings";
import { SessionListSettings } from "./settings/SessionListSettings";
import { McpConfig, type McpConfigHandle } from "./mcp/McpConfig";
import { WebSearchSettings } from "./settings/WebSearchSettings";
import { Button } from "@/components/ui/Button";

export type SettingsTab =
  "general" | "herdr" | "browser" | "search" | "channels" | "models" | "tools" | "skills" | "plugins" | "mcp" | "about";

interface SettingsConfigProps {
  /**
   * Controlled visibility. The deferred wrapper keeps this panel mounted
   * through the exit fade and only flips `open`, so the Dialog's close
   * animation plays instead of the subtree dropping outright.
   */
  open: boolean;
  cwd: string | null;
  sessionId: string | null;
  initialTab?: SettingsTab;
  navigationRequestId?: number;
  onClose: () => void;
  onModelsChanged: () => void;
  onPluginsReloaded: () => void;
  onChannelsChanged: (snapshot: ChannelsSnapshot) => void;
  chatAppearance: ChatAppearancePreferences;
  chatAppearanceSaving: boolean;
  onChatAppearanceChange: (preferences: ChatAppearancePreferences) => Promise<void>;
  /** Element to refocus on close; the deferred wrapper captures it before any loading frame takes focus. */
  returnFocusTarget?: HTMLElement | null;
  /**
   * false skips the dialog's first enter animation (loading-frame handoff:
   * animating in over the already-visible frame reads as popping up twice).
   * The exit always animates.
   */
  animateEnter?: boolean;
}

export function SettingsConfig({
  open,
  cwd,
  sessionId,
  initialTab = "general",
  navigationRequestId = 0,
  onClose,
  onModelsChanged,
  onPluginsReloaded,
  onChannelsChanged,
  chatAppearance,
  chatAppearanceSaving,
  onChatAppearanceChange,
  returnFocusTarget,
  animateEnter,
}: SettingsConfigProps) {
  const isMobile = useIsMobile();
  const { isDark, toggleTheme } = useTheme();
  const { language, setLanguage, t } = useI18n();
  const [activeTab, setActiveTab] = useState<SettingsTab>(initialTab);
  const activeTabRef = useRef(activeTab);
  activeTabRef.current = activeTab;
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const skillsConfigRef = useRef<SkillsConfigHandle>(null);
  const mcpConfigRef = useRef<McpConfigHandle>(null);
  const returnFocusRef = useRef<HTMLElement | null>(
    returnFocusTarget !== undefined
      ? returnFocusTarget
      : document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null,
  );

  const requestSettingsTransition = useCallback((action: () => void) => {
    if (activeTabRef.current === "skills" && skillsConfigRef.current) {
      skillsConfigRef.current.requestLeave(action);
      return;
    }
    if (activeTabRef.current === "mcp" && mcpConfigRef.current) {
      mcpConfigRef.current.requestLeave(action);
      return;
    }
    action();
  }, []);

  useEffect(() => {
    if (initialTab !== activeTabRef.current) requestSettingsTransition(() => setActiveTab(initialTab));
    // navigationRequestId intentionally retries an externally requested tab after a cancelled dirty-editor prompt.
  }, [initialTab, navigationRequestId, requestSettingsTransition]);

  // Focus follows visibility rather than lifetime: the deferred wrapper keeps
  // this panel mounted through the exit fade, so cleanup must not steal focus
  // back while the dialog is still on screen. Restoring runs only once the
  // dialog is actually gone (open=false and the fade finished).
  useEffect(() => {
    if (!open) return;
    const returnFocus = returnFocusRef.current;
    closeButtonRef.current?.focus();
    return () => {
      if (returnFocus instanceof HTMLElement && document.contains(returnFocus)) returnFocus.focus();
    };
  }, [open]);

  useEffect(() => {
    const dialog = document.querySelector('[role="dialog"][aria-modal="true"]');
    if (dialog && !dialog.contains(document.activeElement)) {
      document.getElementById(`settings-tab-${activeTab}`)?.focus();
    }
  }, [activeTab, navigationRequestId]);

  const tabs: { id: SettingsTab; label: string }[] = [
    { id: "general", label: t("general", "General") },
    { id: "models", label: t("models", "Models") },
    { id: "skills", label: t("skills", "Skills") },
    { id: "plugins", label: t("plugins", "Plugins") },
    { id: "mcp", label: t("mcpTab", "MCP") },
    { id: "browser", label: t("browser", "Browser") },
    { id: "search", label: t("searchTab", "Search") },
    { id: "herdr", label: t("herdr", "Herdr") },
    { id: "channels", label: t("channels", "Channels") },
    { id: "tools", label: t("developerTools", "Developer Tools") },
    { id: "about", label: t("about", "About") },
  ];

  return (
    <Dialog
      open={open}
      animateEnter={animateEnter}
      onClose={() => requestSettingsTransition(onClose)}
      ariaLabel={t("settings", "Settings")}
      width={isMobile ? "calc(100vw - 16px)" : 960}
      style={{
        maxWidth: "calc(100vw - 16px)",
        height: isMobile ? "calc(100dvh - 16px)" : "82vh",
        maxHeight: "calc(100dvh - 16px)",
        background: "var(--bg)",
        border: "1px solid var(--border)",
        borderRadius: 10,
        display: "flex",
        flexDirection: "column",
        boxShadow: "0 8px 32px rgba(0,0,0,0.18)",
        overflow: "hidden",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 12,
          padding: "13px 18px",
          borderBottom: "1px solid var(--border)",
          flexShrink: 0,
        }}
      >
        <div style={{ minWidth: 0 }}>
          <div style={{ fontSize: 16, fontWeight: 700, color: "var(--text)" }}>{t("settings", "Settings")}</div>
          {!isMobile && (
            <div style={{ marginTop: 2, fontSize: 11, color: "var(--text-dim)" }}>
              {t("settingsDescription", "Manage app preferences, models, skills, and plugins.")}
            </div>
          )}
        </div>
        <Button
          ref={closeButtonRef}
          type="button"
          onClick={() => requestSettingsTransition(onClose)}
          aria-label={t("close", "Close")}
          variant="ghost"
          style={{
            fontSize: 20,
            lineHeight: 1,
            width: 36,
            height: 36,
            padding: 0,
            borderRadius: 7,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          ×
        </Button>
      </div>

      <div style={{ flex: 1, minHeight: 0, minWidth: 0, display: "flex", overflow: "hidden" }}>
        <div
          role="tablist"
          aria-label={t("settings", "Settings")}
          aria-orientation="vertical"
          style={{
            width: isMobile ? 112 : 168,
            display: "flex",
            flexDirection: "column",
            gap: 4,
            padding: isMobile ? "10px 8px" : "12px 10px",
            borderRight: "1px solid var(--border)",
            overflowY: "auto",
            flexShrink: 0,
            background: "var(--bg-panel)",
          }}
        >
          {tabs.map((tab) => {
            const active = tab.id === activeTab;
            return (
              <Button
                key={tab.id}
                id={`settings-tab-${tab.id}`}
                type="button"
                role="tab"
                aria-selected={active}
                aria-controls="settings-tabpanel"
                tabIndex={active ? 0 : -1}
                onClick={() => {
                  if (!active) requestSettingsTransition(() => setActiveTab(tab.id));
                }}
                onKeyDown={(event) => {
                  const currentIndex = tabs.findIndex((item) => item.id === tab.id);
                  let nextIndex: number | undefined;
                  if (event.key === "ArrowDown") nextIndex = (currentIndex + 1) % tabs.length;
                  if (event.key === "ArrowUp") nextIndex = (currentIndex - 1 + tabs.length) % tabs.length;
                  if (event.key === "Home") nextIndex = 0;
                  if (event.key === "End") nextIndex = tabs.length - 1;
                  if (nextIndex === undefined) return;
                  event.preventDefault();
                  const nextTab = tabs[nextIndex];
                  requestSettingsTransition(() => {
                    setActiveTab(nextTab.id);
                    document.getElementById(`settings-tab-${nextTab.id}`)?.focus();
                  });
                }}
                className="pi-settings-tab"
                style={{
                  position: "relative",
                  width: "100%",
                  minHeight: 40,
                  padding: isMobile ? "8px 10px" : "8px 12px",
                  fontSize: 12,
                  lineHeight: 1.35,
                  textAlign: "left",
                  overflowWrap: "anywhere",
                }}
              >
                {tab.label}
              </Button>
            );
          })}
        </div>

        <div
          id="settings-tabpanel"
          role="tabpanel"
          aria-labelledby={`settings-tab-${activeTab}`}
          style={{ flex: 1, minWidth: 0, minHeight: 0, overflow: "hidden", display: "flex" }}
        >
          {activeTab === "general" && (
            <GeneralSettings
              language={language}
              onLanguageChange={setLanguage}
              isDark={isDark}
              onThemeChange={(nextDark) => {
                if (nextDark !== isDark) toggleTheme();
              }}
              chatAppearance={chatAppearance}
              chatAppearanceSaving={chatAppearanceSaving}
              onChatAppearanceChange={onChatAppearanceChange}
            />
          )}
          {activeTab === "browser" && <BrowserSettings sessionId={sessionId} />}
          {activeTab === "search" && <WebSearchSettings />}
          {activeTab === "mcp" && <McpConfig ref={mcpConfigRef} cwd={cwd} sessionId={sessionId} />}
          {activeTab === "herdr" && <HerdrSettings />}
          {activeTab === "models" && (
            <ModelsConfig embedded cwd={cwd} onClose={() => undefined} onChanged={onModelsChanged} />
          )}
          {activeTab === "tools" && <ToolchainsConfig cwd={cwd} />}
          {activeTab === "channels" && <ChannelsConfig onSnapshotChange={onChannelsChanged} />}
          {activeTab === "skills" &&
            (cwd ? (
              <SkillsConfig ref={skillsConfigRef} embedded cwd={cwd} onClose={() => undefined} />
            ) : (
              <ProjectRequired />
            ))}
          {activeTab === "plugins" &&
            (cwd ? (
              <PluginsConfig
                embedded
                cwd={cwd}
                sessionId={sessionId}
                onClose={() => undefined}
                onReloaded={onPluginsReloaded}
              />
            ) : (
              <ProjectRequired />
            ))}
          {activeTab === "about" && <AboutSettings onClose={onClose} />}
        </div>
      </div>
    </Dialog>
  );
}

function AboutSettings({ onClose }: { onClose: () => void }) {
  const { t } = useI18n();

  return (
    <div
      style={{
        width: "100%",
        overflowY: "auto",
        padding: "28px clamp(18px, 5vw, 52px)",
        display: "flex",
      }}
    >
      <div style={{ width: "100%", maxWidth: 620, margin: "auto" }}>
        <section
          style={{
            display: "flex",
            alignItems: "center",
            gap: 16,
            paddingBottom: 26,
          }}
        >
          <img
            aria-hidden="true"
            src={appIconUrl}
            alt=""
            style={{
              width: 64,
              height: 64,
              objectFit: "contain",
              flexShrink: 0,
              filter: "drop-shadow(0 4px 10px color-mix(in srgb, #000 12%, transparent))",
            }}
          />
          <div>
            <h2 style={{ margin: 0, fontSize: 18, color: "var(--text)" }}>{APP_DISPLAY_NAME}</h2>
            <p style={{ margin: "5px 0 0", fontSize: 12, lineHeight: 1.6, color: "var(--text-dim)" }}>
              {t("aboutDescription", "App, Pi, and project information.")}
            </p>
          </div>
        </section>

        <section>
          <h2 style={{ margin: "0 0 12px", fontSize: 14, color: "var(--text)" }}>
            {t("applicationInformation", "Application information")}
          </h2>
          <div
            style={{
              border: "1px solid var(--border)",
              borderRadius: 8,
              background: "var(--bg-panel)",
              overflow: "hidden",
            }}
          >
            <AboutRow label={t("softwareVersion", "Software version")} value={`v${APP_VERSION}`} />
            <AboutRow label={t("piVersion", "Pi version")} value={`v${PI_VERSION}`} />
            <AboutRow label={t("author", "Original author")} value={APP_AUTHOR} />
            <AboutRow label={t("forkAuthor", "Fork author")} value={APP_FORK_AUTHOR} />
            <AboutRow
              label={t("officialWebsite", "Official website")}
              value={
                <Button
                  type="button"
                  title={t("openOfficialWebsite", "Open official website")}
                  onClick={() => void window.piBridge.openExternal(APP_WEBSITE_URL)}
                  variant="link"
                  style={{
                    maxWidth: "100%",
                    padding: 0,
                    fontFamily: "var(--font-mono)",
                    fontSize: 12,
                    overflowWrap: "anywhere",
                    textAlign: "right",
                  }}
                >
                  https://zhenghaof.github.io/pi-desktop/ ↗
                </Button>
              }
            />
            <AboutRow
              label={t("githubRepository", "GitHub repository")}
              value={
                <Button
                  type="button"
                  title={t("openGithubRepository", "Open GitHub repository")}
                  onClick={() => void window.piBridge.openExternal(APP_GITHUB_URL)}
                  variant="link"
                  style={{
                    maxWidth: "100%",
                    padding: 0,
                    fontFamily: "var(--font-mono)",
                    fontSize: 12,
                    overflowWrap: "anywhere",
                    textAlign: "right",
                  }}
                >
                  github.com/ZhengHaoF/pi-desktop ↗
                </Button>
              }
              last
            />
          </div>
        </section>

        <SoftwareUpdate onClose={onClose} />
      </div>
    </div>
  );
}

type UpdateAction = "status" | "check" | "download" | "install" | "automatic" | "logs";

function SoftwareUpdate({ onClose }: { onClose: () => void }) {
  const { language, t } = useI18n();
  const [state, setState] = useState<DesktopUpdateState | null>(null);
  const [pendingAction, setPendingAction] = useState<UpdateAction | null>(null);
  const [actionFailed, setActionFailed] = useState(false);
  const headingId = useId();
  const automaticChecksControlId = useId();
  const automaticChecksDescriptionId = useId();

  useEffect(() => {
    let disposed = false;
    let receivedStateEvent = false;
    const unsubscribe = window.piBridge.onUpdateState((nextState) => {
      if (disposed) return;
      receivedStateEvent = true;
      setState(nextState);
      setActionFailed(false);
    });

    void window.piBridge
      .getUpdateState()
      .then((nextState) => {
        if (!disposed && !receivedStateEvent) setState(nextState);
      })
      .catch(() => {
        if (!disposed && !receivedStateEvent) setActionFailed(true);
      });

    return () => {
      disposed = true;
      unsubscribe();
    };
  }, []);

  const performAction = async (action: UpdateAction, operation: () => Promise<unknown>): Promise<void> => {
    setPendingAction(action);
    setActionFailed(false);
    try {
      await operation();
    } catch {
      setActionFailed(true);
    } finally {
      setPendingAction(null);
    }
  };

  const phase = state?.phase;
  const isBusy = pendingAction !== null;
  const statusTitle = getUpdateStatusTitle(state, t);

  return (
    <section aria-labelledby={headingId} style={{ marginTop: 28 }}>
      <h2 id={headingId} style={{ margin: "0 0 6px", fontSize: 14, color: "var(--text)" }}>
        {t("softwareUpdate", "Software update")}
      </h2>
      <p style={{ margin: "0 0 12px", fontSize: 12, lineHeight: 1.6, color: "var(--text-dim)" }}>
        {t("softwareUpdateDescription", "Check stable releases and choose when a downloaded update is installed.")}
      </p>

      <div
        style={{
          border: "1px solid var(--border)",
          borderRadius: 8,
          background: "var(--bg-panel)",
          overflow: "hidden",
        }}
      >
        <div style={{ padding: 16 }}>
          <div
            role="status"
            aria-live="polite"
            aria-atomic="true"
            style={{ display: "flex", alignItems: "flex-start", gap: 10 }}
          >
            <StatusDot size="md" color={updateStatusColor(phase)} style={{ marginTop: 5 }} />
            <div style={{ minWidth: 0 }}>
              <div style={{ fontSize: 13, fontWeight: 650, color: "var(--text)" }}>{statusTitle}</div>
              {state && (
                <div style={{ marginTop: 3, fontSize: 11, color: "var(--text-dim)" }}>
                  {t("currentVersion", "Current version")}: {displayVersion(state.currentVersion)}
                </div>
              )}
            </div>
          </div>

          {state?.checkedAt && (phase === "up-to-date" || phase === "idle") && (
            <p style={updateDetailStyle}>
              {t("lastChecked", "Last checked")}: {formatUpdateDate(state.checkedAt, language)}
            </p>
          )}

          {phase === "disabled" && (
            <p style={updateDetailStyle}>
              {t(
                "updatesDisabledDescription",
                "Software updates are available only in installed production builds on supported platforms.",
              )}
            </p>
          )}

          {state && (phase === "available" || phase === "downloading" || phase === "downloaded") && (
            <UpdateReleaseDetails state={state} language={language} />
          )}

          {state && phase === "downloading" && <UpdateDownloadProgress state={state} language={language} />}

          {state && phase === "downloaded" && (
            <p style={updateDetailStyle}>
              {state.installBlockedByActiveSessions
                ? t(
                    "updateInstallBlockedByActiveSessions",
                    "Active Agent tasks must finish before restart. Choose Later to install when you next fully quit.",
                  )
                : t(
                    "updateRestartWarning",
                    "Restart now, or choose Later to install when you next fully quit the app.",
                  )}
            </p>
          )}

          {state?.phase === "error" && state.error && (
            <div role="alert" aria-atomic="true" style={{ marginTop: 12 }}>
              <p style={{ margin: 0, fontSize: 12, lineHeight: 1.55, color: "var(--danger)" }}>
                {getUpdateErrorMessage(state.error, t)}
              </p>
              <code style={{ display: "block", marginTop: 5, fontSize: 10, color: "var(--text-dim)" }}>
                {state.error.code}
              </code>
            </div>
          )}

          {actionFailed && (
            <p role="alert" style={{ margin: "12px 0 0", fontSize: 12, lineHeight: 1.55, color: "var(--danger)" }}>
              {t("updateActionFailed", "The update action could not be completed. Try again or open the logs.")}
            </p>
          )}

          <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginTop: 16 }}>
            {(phase === "idle" || phase === "up-to-date") && (
              <UpdateButton
                primary
                disabled={isBusy}
                busy={pendingAction === "check"}
                label={t("checkForUpdates", "Check for updates")}
                onClick={() => void performAction("check", () => window.piBridge.checkForUpdates())}
              />
            )}
            {phase === "checking" && (
              <UpdateButton
                primary
                disabled
                busy
                label={t("checkingForUpdates", "Checking for updates…")}
                onClick={() => undefined}
              />
            )}
            {phase === "available" && (
              <UpdateButton
                primary
                disabled={isBusy}
                busy={pendingAction === "download"}
                label={t("downloadUpdate", "Download update")}
                onClick={() => void performAction("download", () => window.piBridge.downloadUpdate())}
              />
            )}
            {state && phase === "downloaded" && (
              <>
                <UpdateButton
                  primary
                  disabled={isBusy || state.installBlockedByActiveSessions}
                  busy={pendingAction === "install"}
                  label={t("restartAndInstall", "Restart and install")}
                  onClick={() => void performAction("install", () => window.piBridge.installUpdate())}
                />
                <UpdateButton disabled={isBusy} label={t("installLater", "Later")} onClick={onClose} />
              </>
            )}
            {state?.phase === "error" && state.canRetry && (
              <UpdateButton
                primary
                disabled={isBusy}
                busy={pendingAction === "check"}
                label={t("retryUpdate", "Retry")}
                onClick={() => void performAction("check", () => window.piBridge.checkForUpdates())}
              />
            )}
            {!state && actionFailed && (
              <UpdateButton
                primary
                disabled={isBusy}
                busy={pendingAction === "status"}
                label={t("retryUpdate", "Retry")}
                onClick={() =>
                  void performAction("status", async () => {
                    setState(await window.piBridge.getUpdateState());
                  })
                }
              />
            )}
            {(phase === "error" || actionFailed) && (
              <UpdateButton
                disabled={isBusy}
                busy={pendingAction === "logs"}
                label={t("openLogs", "Open logs")}
                onClick={() => void performAction("logs", () => window.piBridge.openLogs())}
              />
            )}
          </div>
        </div>

        <div
          style={{
            minHeight: 56,
            padding: "10px 14px",
            borderTop: "1px solid var(--border)",
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 16,
          }}
        >
          <div>
            <label htmlFor={automaticChecksControlId} style={{ fontSize: 12, color: "var(--text)" }}>
              {t("automaticUpdateChecks", "Automatically check for updates")}
            </label>
            <div
              id={automaticChecksDescriptionId}
              style={{ marginTop: 3, fontSize: 10, lineHeight: 1.45, color: "var(--text-dim)" }}
            >
              {t("automaticUpdateChecksDescription", "Checks periodically without downloading updates automatically.")}
            </div>
          </div>
          <Checkbox
            id={automaticChecksControlId}
            aria-describedby={automaticChecksDescriptionId}
            checked={state?.automaticChecksEnabled ?? false}
            disabled={!state || phase === "disabled" || isBusy}
            onChange={(enabled) => {
              void performAction("automatic", async () => {
                const nextState = await window.piBridge.setAutomaticUpdateChecks(enabled);
                setState(nextState);
              });
            }}
            style={{ width: 18, height: 18, margin: 0, accentColor: "var(--accent)", cursor: "pointer" }}
          />
        </div>
      </div>
    </section>
  );
}

function UpdateReleaseDetails({ state, language }: { state: DesktopUpdateState; language: AppLanguage }) {
  const { t } = useI18n();
  return (
    <div style={{ marginTop: 12, fontSize: 12, lineHeight: 1.55, color: "var(--text-muted)" }}>
      {state.availableVersion && (
        <div>
          {t("availableVersion", "Available version")}: {displayVersion(state.availableVersion)}
        </div>
      )}
      {state.releaseName && <div>{state.releaseName}</div>}
      {state.releaseDate && (
        <div>
          {t("releaseDate", "Released")}: {formatUpdateDate(state.releaseDate, language)}
        </div>
      )}
      {state.releaseNotes && (
        <div style={{ marginTop: 10 }}>
          <div style={{ marginBottom: 5, fontWeight: 650, color: "var(--text)" }}>
            {t("releaseNotes", "Release notes")}
          </div>
          <pre
            tabIndex={0}
            aria-label={t("releaseNotes", "Release notes")}
            style={{
              margin: 0,
              maxHeight: 180,
              overflowY: "auto",
              padding: 10,
              border: "1px solid var(--border)",
              borderRadius: 6,
              background: "var(--bg)",
              color: "var(--text-muted)",
              fontFamily: "inherit",
              fontSize: 11,
              lineHeight: 1.55,
              whiteSpace: "pre-wrap",
              overflowWrap: "anywhere",
            }}
          >
            {state.releaseNotes}
          </pre>
        </div>
      )}
    </div>
  );
}

function UpdateDownloadProgress({ state, language }: { state: DesktopUpdateState; language: AppLanguage }) {
  const { t } = useI18n();
  const percent = Number.isFinite(state.percent) ? Math.max(0, Math.min(100, state.percent ?? 0)) : 0;
  const progressText = `${percent.toFixed(1)}%`;
  return (
    <div style={{ marginTop: 14 }}>
      <progress
        max={100}
        value={percent}
        aria-label={t("updateDownloadProgress", "Update download progress")}
        aria-valuetext={progressText}
        style={{ width: "100%", height: 8, accentColor: "var(--accent)" }}
      />
      <div
        style={{
          marginTop: 5,
          display: "flex",
          flexWrap: "wrap",
          justifyContent: "space-between",
          gap: 8,
          fontSize: 10,
          color: "var(--text-dim)",
        }}
      >
        <span>{progressText}</span>
        <span>
          {state.transferred !== undefined && state.total !== undefined
            ? `${formatBytes(state.transferred, language)} / ${formatBytes(state.total, language)}`
            : t("calculatingDownloadSize", "Calculating size…")}
          {state.bytesPerSecond !== undefined && state.bytesPerSecond > 0
            ? ` · ${formatBytes(state.bytesPerSecond, language)}/${t("secondShort", "s")}`
            : ""}
        </span>
      </div>
    </div>
  );
}

function UpdateButton({
  label,
  onClick,
  primary = false,
  disabled = false,
  busy = false,
}: {
  label: string;
  onClick: () => void;
  primary?: boolean;
  disabled?: boolean;
  busy?: boolean;
}) {
  return (
    <Button
      type="button"
      aria-label={label}
      aria-busy={busy || undefined}
      disabled={disabled}
      onClick={onClick}
      variant={primary ? "primary" : "default"}
      style={{
        minHeight: 34,
        padding: "7px 12px",
        fontSize: 12,
        fontWeight: 600,
      }}
    >
      {label}
    </Button>
  );
}

function getUpdateStatusTitle(state: DesktopUpdateState | null, t: (key: string, fallback: string) => string): string {
  if (!state) return t("loadingUpdateStatus", "Loading update status…");
  switch (state.phase) {
    case "disabled":
      return t("updatesDisabled", "Updates are unavailable in this build");
    case "idle":
      return t("readyToCheckForUpdates", "Ready to check for updates");
    case "checking":
      return t("checkingForUpdates", "Checking for updates…");
    case "up-to-date":
      return t("appIsUpToDate", "You are using the latest version");
    case "available":
      return t("updateAvailable", "An update is available");
    case "downloading":
      return t("downloadingUpdate", "Downloading update…");
    case "downloaded":
      return t("updateReadyToInstall", "Update ready to install");
    case "installing":
      return t("installingUpdate", "Restarting to install the update…");
    case "error":
      return t("updateFailed", "Update failed");
  }
}

function getUpdateErrorMessage(
  error: NonNullable<DesktopUpdateState["error"]>,
  t: (key: string, fallback: string) => string,
): string {
  switch (error.code) {
    case "UPDATE_OFFLINE":
      return t("updateErrorOffline", "Unable to reach the update service. Check your network and try again.");
    case "UPDATE_NOT_PUBLISHED":
      return t("updateErrorNotPublished", "The update is not available yet and may still be under release review.");
    case "UPDATE_METADATA_INVALID":
      return t(
        "updateErrorMetadataInvalid",
        "The update information is invalid or incomplete. This version was not changed.",
      );
    case "UPDATE_SIGNATURE_INVALID":
      return t("updateErrorSignatureInvalid", "Update signature verification failed. Installation was stopped.");
    case "UPDATE_DOWNLOAD_FAILED":
      return t("updateErrorDownloadFailed", "The download failed. You can continue using this version and try again.");
    case "UPDATE_BUSY":
      return t("updateErrorBusy", "Another update task is already in progress.");
    case "UPDATE_INVALID_STATE":
      return t("updateErrorInvalidState", "This update action is not available in the current state.");
    case "UPDATE_UNSUPPORTED":
      return t("updateErrorUnsupported", "This build or platform does not support automatic updates.");
    case "UPDATE_UNKNOWN":
      return t("updateErrorUnknown", "An unexpected update error occurred. This version was not changed.");
  }
}

function AboutRow({ label, value, last = false }: { label: string; value: React.ReactNode; last?: boolean }) {
  return (
    <div
      style={{
        minHeight: 52,
        padding: "10px 12px",
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: 20,
        borderBottom: last ? "none" : "1px solid var(--border)",
      }}
    >
      <span style={{ flexShrink: 0, fontSize: 13, color: "var(--text-muted)" }}>{label}</span>
      <span
        style={{
          minWidth: 0,
          color: "var(--text)",
          fontFamily: "var(--font-mono)",
          fontSize: 12,
          textAlign: "right",
        }}
      >
        {value}
      </span>
    </div>
  );
}

function GeneralSettings({
  language,
  onLanguageChange,
  isDark,
  onThemeChange,
  chatAppearance,
  chatAppearanceSaving,
  onChatAppearanceChange,
}: {
  language: AppLanguage;
  onLanguageChange: (language: AppLanguage) => void;
  isDark: boolean;
  onThemeChange: (dark: boolean) => void;
  chatAppearance: ChatAppearancePreferences;
  chatAppearanceSaving: boolean;
  onChatAppearanceChange: (preferences: ChatAppearancePreferences) => Promise<void>;
}) {
  const { t } = useI18n();
  const [backgroundMode, setBackgroundMode] = useState(true);
  const [backgroundModeLoading, setBackgroundModeLoading] = useState(true);
  const [backgroundModeSaving, setBackgroundModeSaving] = useState(false);
  const [backgroundModeError, setBackgroundModeError] = useState<"load" | "save" | null>(null);
  const [managedProcessesEnabled, setManagedProcessesEnabled] = useState(false);
  const [managedProcessesLoading, setManagedProcessesLoading] = useState(true);
  const [managedProcessesSaving, setManagedProcessesSaving] = useState(false);
  const [managedProcessesError, setManagedProcessesError] = useState<"load" | "save" | null>(null);
  const [managedProcessCapability, setManagedProcessCapability] = useState<ManagedProcessCapability | null>(null);
  const [autoSessionTitle, setAutoSessionTitle] = useState(() => isAutoSessionTitleEnabled());
  const [chatAppearanceError, setChatAppearanceError] = useState(false);
  const languageControlId = useId();
  const backgroundModeControlId = useId();
  const managedProcessesControlId = useId();
  const autoSessionTitleControlId = useId();
  const chatFontSizeControlId = useId();
  const chatLayoutControlId = useId();
  const chatAssistantWidthControlId = useId();
  const themeControlId = useId();
  useEffect(() => {
    let disposed = false;
    void Promise.all([window.piBridge.getUiState(), window.piBridge.getManagedProcessCapability()])
      .then(([state, capability]) => {
        if (!disposed) {
          setBackgroundMode(state.backgroundMode !== false);
          setManagedProcessesEnabled(state.managedProcessesEnabled === true);
          setManagedProcessCapability(capability);
        }
      })
      .catch(() => {
        if (!disposed) {
          setBackgroundModeError("load");
          setManagedProcessesError("load");
        }
      })
      .finally(() => {
        if (!disposed) {
          setBackgroundModeLoading(false);
          setManagedProcessesLoading(false);
        }
      });
    return () => {
      disposed = true;
    };
  }, []);

  const saveBackgroundMode = async (next: boolean): Promise<void> => {
    const previous = backgroundMode;
    setBackgroundMode(next);
    setBackgroundModeSaving(true);
    setBackgroundModeError(null);
    try {
      await window.piBridge.setUiState({ backgroundMode: next });
    } catch {
      setBackgroundMode(previous);
      setBackgroundModeError("save");
    } finally {
      setBackgroundModeSaving(false);
    }
  };
  const saveManagedProcesses = async (next: boolean): Promise<void> => {
    const previous = managedProcessesEnabled;
    setManagedProcessesEnabled(next);
    setManagedProcessesSaving(true);
    setManagedProcessesError(null);
    try {
      await window.piBridge.setUiState({ managedProcessesEnabled: next });
    } catch {
      setManagedProcessesEnabled(previous);
      setManagedProcessesError("save");
    } finally {
      setManagedProcessesSaving(false);
    }
  };
  const saveChatAppearance = async (next: ChatAppearancePreferences): Promise<void> => {
    setChatAppearanceError(false);
    try {
      await onChatAppearanceChange(next);
    } catch {
      setChatAppearanceError(true);
    }
  };
  const managedProcessCapabilityMessage = (() => {
    if (!managedProcessCapability || managedProcessCapability.ready) return null;
    switch (managedProcessCapability.errorCode) {
      case "ARCH_UNSUPPORTED":
        return t("managedProcessesArchUnsupported", "Managed processes require Windows x64 on this platform.");
      case "HELPER_MISSING":
        return t(
          "managedProcessesHelperMissing",
          "The Windows process helper is missing. Reinstall the app, then restart it.",
        );
      case "HELPER_INTEGRITY":
        return t(
          "managedProcessesHelperIntegrity",
          "The Windows process helper failed its integrity check. Reinstall the app, then restart it.",
        );
      case "OWNER_IDENTITY_UNAVAILABLE":
        return t(
          "managedProcessesOwnerUnavailable",
          "Windows process ownership could not be verified. Restart the app before enabling this feature.",
        );
      case "REAPER_UNHEALTHY":
        return t(
          "managedProcessesReaperUnhealthy",
          "A previous process tree could not be safely verified as stopped. Restart the app or export diagnostics.",
        );
      default:
        return t("managedProcessesUnsupported", "Managed processes are not available on this platform.");
    }
  })();
  const managedProcessesUnavailable = !managedProcessCapability?.ready;
  return (
    <div style={{ width: "100%", overflowY: "auto", padding: "28px clamp(18px, 5vw, 52px)" }}>
      <section style={{ maxWidth: 620 }}>
        <h2 style={{ margin: 0, fontSize: 14, color: "var(--text)" }}>
          {t("interfaceLanguage", "Interface language")}
        </h2>
        <p style={{ margin: "6px 0 16px", fontSize: 12, lineHeight: 1.6, color: "var(--text-dim)" }}>
          {t("interfaceLanguageDescription", "Choose the language used by the app. Changes take effect immediately.")}
        </p>
        <SettingRow label={t("language", "Language")} controlId={languageControlId}>
          <Select
            id={languageControlId}
            value={language}
            onChange={(value) => onLanguageChange(value as AppLanguage)}
            options={[
              { value: "en-US", label: "English" },
              { value: "zh-CN", label: "简体中文" },
              { value: "zh-TW", label: "繁體中文" },
            ]}
          />
        </SettingRow>
      </section>

      <div style={{ height: 1, background: "var(--border)", maxWidth: 620, margin: "28px 0" }} />

      <WindowsAgentShellSetting />

      <DefaultToolPresetSetting />

      <section style={{ maxWidth: 620 }}>
        <h2 style={{ margin: 0, fontSize: 14, color: "var(--text)" }}>{t("managedProcesses", "Managed processes")}</h2>
        <p style={{ margin: "6px 0 16px", fontSize: 12, lineHeight: 1.6, color: "var(--text-dim)" }}>
          {t(
            "managedProcessesDescription",
            "Let Agents run development servers and watchers under app-owned lifecycle control. Processes have the same local access as Bash and are not a sandbox.",
          )}
        </p>
        <SettingRow
          label={t("managedProcessesEnable", "Enable managed background processes")}
          controlId={managedProcessesControlId}
        >
          <label
            htmlFor={managedProcessesControlId}
            style={{
              width: 36,
              height: 36,
              display: "grid",
              placeItems: "center",
              flexShrink: 0,
              cursor: managedProcessesUnavailable ? "not-allowed" : "pointer",
            }}
          >
            <Checkbox
              id={managedProcessesControlId}
              checked={managedProcessesEnabled}
              disabled={managedProcessesUnavailable || managedProcessesLoading || managedProcessesSaving}
              onChange={saveManagedProcesses}
            />
          </label>
        </SettingRow>
        {managedProcessCapabilityMessage && (
          <p style={{ margin: "8px 0 0", fontSize: 12, lineHeight: 1.55, color: "var(--text-dim)" }}>
            {managedProcessCapabilityMessage}
          </p>
        )}
        {managedProcessCapability?.ready &&
          managedProcessCapability.backend === "windows-job" &&
          managedProcessCapability.helperProvenance === "windows-native-dev" && (
            <p style={{ margin: "8px 0 0", fontSize: 12, lineHeight: 1.55, color: "var(--text-dim)" }}>
              {t("managedProcessesDeveloperBuild", "Developer build — not a release-validated Windows helper.")}
            </p>
          )}
        {managedProcessesError && (
          <p role="alert" style={{ margin: "8px 0 0", fontSize: 12, lineHeight: 1.55, color: "var(--danger)" }}>
            {managedProcessesError === "save"
              ? t(
                  "managedProcessesSaveFailed",
                  "Managed process settings could not be saved. The previous setting was restored.",
                )
              : t(
                  "managedProcessesLoadFailed",
                  "Managed process settings could not be loaded. The feature remains disabled.",
                )}
          </p>
        )}
      </section>

      <div style={{ height: 1, background: "var(--border)", maxWidth: 620, margin: "28px 0" }} />

      <section style={{ maxWidth: 620 }}>
        <h2 style={{ margin: 0, fontSize: 14, color: "var(--text)" }}>{t("backgroundMode", "Background mode")}</h2>
        <p style={{ margin: "6px 0 16px", fontSize: 12, lineHeight: 1.6, color: "var(--text-dim)" }}>
          {t("backgroundModeDescription", "Keep messaging channels connected when the window is closed.")}
        </p>
        <SettingRow label={t("closeToTray", "Close window to tray")} controlId={backgroundModeControlId}>
          <label
            htmlFor={backgroundModeControlId}
            style={{
              width: 36,
              height: 36,
              display: "grid",
              placeItems: "center",
              flexShrink: 0,
              cursor: "pointer",
            }}
          >
            <Checkbox
              id={backgroundModeControlId}
              checked={backgroundMode}
              disabled={backgroundModeLoading || backgroundModeSaving}
              onChange={(checked) => {
                void saveBackgroundMode(checked);
              }}
            />
          </label>
        </SettingRow>
        {backgroundModeError && (
          <p role="alert" style={{ margin: "8px 0 0", fontSize: 12, lineHeight: 1.55, color: "var(--danger)" }}>
            {backgroundModeError === "save"
              ? t("backgroundModeSaveFailed", "Background mode could not be saved. The previous setting was restored.")
              : t("backgroundModeLoadFailed", "Background mode could not be loaded. The default remains selected.")}
          </p>
        )}
      </section>

      <div style={{ height: 1, background: "var(--border)", maxWidth: 620, margin: "28px 0" }} />

      <section style={{ maxWidth: 620 }}>
        <h2 style={{ margin: 0, fontSize: 14, color: "var(--text)" }}>{t("conversationSettings", "Conversation")}</h2>
        <p style={{ margin: "6px 0 16px", fontSize: 12, lineHeight: 1.6, color: "var(--text-dim)" }}>
          {t(
            "conversationSettingsDescription",
            "Control automatic titles, chat text size, and the conversation reading width.",
          )}
        </p>
        <div style={{ display: "grid", gap: 10 }}>
          <SettingRow label={t("autoSessionTitle", "Auto-title new sessions")} controlId={autoSessionTitleControlId}>
            <label
              htmlFor={autoSessionTitleControlId}
              style={{
                width: 36,
                height: 36,
                display: "grid",
                placeItems: "center",
                flexShrink: 0,
                cursor: "pointer",
              }}
            >
              <Checkbox
                id={autoSessionTitleControlId}
                checked={autoSessionTitle}
                onChange={(next) => {
                  setAutoSessionTitle(next);
                  setAutoSessionTitleEnabled(next);
                }}
              />
            </label>
          </SettingRow>
          <CacheWarmingSettings />
          <DefaultThinkingLevelSettings />
          <SettingRow label={t("chatFontSize", "Chat text size")} controlId={chatFontSizeControlId}>
            <Select
              id={chatFontSizeControlId}
              value={chatAppearance.fontSize}
              disabled={chatAppearanceSaving}
              onChange={(value) => {
                void saveChatAppearance({
                  ...chatAppearance,
                  fontSize: value as ChatFontSize,
                });
              }}
              style={chatAppearanceSaving ? { cursor: "wait" } : undefined}
              options={[
                { value: "small", label: t("chatFontSizeSmall", "Small") },
                { value: "standard", label: t("chatFontSizeStandard", "Standard") },
                { value: "large", label: t("chatFontSizeLarge", "Large") },
                { value: "extra-large", label: t("chatFontSizeExtraLarge", "Extra large") },
              ]}
            />
          </SettingRow>
          <SettingRow label={t("chatLayout", "Conversation width")} controlId={chatLayoutControlId}>
            <Select
              id={chatLayoutControlId}
              value={chatAppearance.layout}
              disabled={chatAppearanceSaving}
              onChange={(value) => {
                void saveChatAppearance({
                  ...chatAppearance,
                  layout: value as ChatLayout,
                });
              }}
              style={chatAppearanceSaving ? { cursor: "wait" } : undefined}
              options={[
                { value: "fixed", label: t("chatLayoutFixed", "Comfortable width") },
                { value: "wide", label: t("chatLayoutWide", "Expanded width") },
              ]}
            />
          </SettingRow>
          <SettingRow label={t("chatAssistantWidth", "Model reply width")} controlId={chatAssistantWidthControlId}>
            <Select
              id={chatAssistantWidthControlId}
              value={chatAppearance.assistantWidth ?? "comfortable"}
              disabled={chatAppearanceSaving}
              onChange={(value) => {
                void saveChatAppearance({
                  ...chatAppearance,
                  assistantWidth: value as ChatAssistantWidth,
                });
              }}
              style={chatAppearanceSaving ? { cursor: "wait" } : undefined}
              options={[
                { value: "comfortable", label: t("chatAssistantWidthComfortable", "Comfortable width") },
                { value: "full", label: t("chatAssistantWidthFull", "Fill conversation column") },
              ]}
            />
          </SettingRow>
        </div>
        {chatAppearanceError && (
          <p role="alert" style={{ margin: "8px 0 0", fontSize: 12, lineHeight: 1.55, color: "var(--danger)" }}>
            {t("chatAppearanceSaveFailed", "Chat appearance could not be saved. The previous settings were restored.")}
          </p>
        )}
      </section>

      <div style={{ height: 1, background: "var(--border)", maxWidth: 620, margin: "28px 0" }} />

      <section style={{ maxWidth: 620 }}>
        <h2 style={{ margin: 0, fontSize: 14, color: "var(--text)" }}>{t("appearance", "Appearance")}</h2>
        <p style={{ margin: "6px 0 16px", fontSize: 12, lineHeight: 1.6, color: "var(--text-dim)" }}>
          {t("appearanceDescription", "Choose the color mode used by the app.")}
        </p>
        <SettingRow label={t("theme", "Theme")} controlId={themeControlId}>
          <Select
            id={themeControlId}
            value={isDark ? "dark" : "light"}
            onChange={(value) => onThemeChange(value === "dark")}
            options={[
              { value: "light", label: t("light", "Light") },
              { value: "dark", label: t("dark", "Dark") },
            ]}
          />
        </SettingRow>
      </section>

      <div style={{ height: 1, background: "var(--border)", maxWidth: 620, margin: "28px 0" }} />

      <SessionListSettings />
    </div>
  );
}

function ProjectRequired() {
  const { t } = useI18n();
  return (
    <div
      style={{
        flex: 1,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 28,
        textAlign: "center",
      }}
    >
      <div style={{ maxWidth: 380 }}>
        <div style={{ fontSize: 14, fontWeight: 650, color: "var(--text)" }}>
          {t("projectRequiredTitle", "Select a project first")}
        </div>
        <div style={{ marginTop: 7, fontSize: 12, lineHeight: 1.6, color: "var(--text-dim)" }}>
          {t(
            "projectRequiredDescription",
            "Skills and plugins depend on the current project. Select a project directory from the sidebar first.",
          )}
        </div>
      </div>
    </div>
  );
}
