import { useEffect, useId, useRef, useState } from "react";
import { useTheme } from "@/hooks/useTheme";
import { useIsMobile } from "@/hooks/useIsMobile";
import { useI18n, type AppLanguage } from "@/i18n";
import { ModelsConfig } from "./ModelsConfig";
import { SkillsConfig } from "./SkillsConfig";
import { PluginsConfig } from "./PluginsConfig";
import { ToolchainsConfig } from "./ToolchainsConfig";
import { BrowserSettings } from "./browser/BrowserSettings";
import { ChannelsConfig } from "./channels/ChannelsConfig";
import type { ChannelsSnapshot } from "@shared/channel-types";
import { APP_WEBSITE_URL } from "@shared/app-links";
import type { DesktopUpdateState } from "../../contract/desktop";
import { APP_AUTHOR, APP_DISPLAY_NAME, APP_GITHUB_URL, APP_VERSION, PI_VERSION } from "@/lib/app-version";
import appIconUrl from "../../../build/icon.png";

export type SettingsTab = "general" | "browser" | "channels" | "models" | "tools" | "skills" | "plugins" | "about";

interface SettingsConfigProps {
  cwd: string | null;
  sessionId: string | null;
  initialTab?: SettingsTab;
  navigationRequestId?: number;
  onClose: () => void;
  onModelsChanged: () => void;
  onPluginsReloaded: () => void;
  onChannelsChanged: (snapshot: ChannelsSnapshot) => void;
}

export function SettingsConfig({
  cwd,
  sessionId,
  initialTab = "general",
  navigationRequestId = 0,
  onClose,
  onModelsChanged,
  onPluginsReloaded,
  onChannelsChanged,
}: SettingsConfigProps) {
  const isMobile = useIsMobile();
  const { isDark, toggleTheme } = useTheme();
  const { language, setLanguage, t } = useI18n();
  const [activeTab, setActiveTab] = useState<SettingsTab>(initialTab);
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const returnFocusRef = useRef<HTMLElement | null>(
    document.activeElement instanceof HTMLElement ? document.activeElement : null,
  );

  useEffect(() => {
    setActiveTab(initialTab);
  }, [initialTab, navigationRequestId]);

  useEffect(() => {
    const returnFocus = returnFocusRef.current;
    closeButtonRef.current?.focus();
    return () => {
      returnFocus?.focus();
    };
  }, []);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog && !dialog.contains(document.activeElement)) {
      document.getElementById(`settings-tab-${activeTab}`)?.focus();
    }
  }, [activeTab, navigationRequestId]);

  const tabs: { id: SettingsTab; label: string }[] = [
    { id: "general", label: t("general", "General") },
    { id: "models", label: t("models", "Models") },
    { id: "skills", label: t("skills", "Skills") },
    { id: "plugins", label: t("plugins", "Plugins") },
    { id: "browser", label: t("browser", "Browser") },
    { id: "channels", label: t("channels", "Channels") },
    { id: "tools", label: t("developerTools", "Developer Tools") },
    { id: "about", label: t("about", "About") },
  ];

  return (
    <div
      role="presentation"
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 1000,
        background: "rgba(0,0,0,0.35)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label={t("settings", "Settings")}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            onClose();
            return;
          }
          if (event.key !== "Tab") return;

          const dialog = dialogRef.current;
          if (!dialog) return;
          const focusable = Array.from(
            dialog.querySelectorAll<HTMLElement>(
              'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
            ),
          ).filter((element) => element.getClientRects().length > 0);
          if (focusable.length === 0) {
            event.preventDefault();
            dialog.focus();
            return;
          }

          const first = focusable[0];
          const last = focusable[focusable.length - 1];
          if (event.shiftKey && (document.activeElement === first || !dialog.contains(document.activeElement))) {
            event.preventDefault();
            last.focus();
          } else if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault();
            first.focus();
          }
        }}
        tabIndex={-1}
        style={{
          width: isMobile ? "calc(100vw - 16px)" : 960,
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
          <button
            ref={closeButtonRef}
            type="button"
            onClick={onClose}
            aria-label={t("close", "Close")}
            style={{
              background: "none",
              border: "none",
              color: "var(--text-muted)",
              cursor: "pointer",
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
          </button>
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
                <button
                  key={tab.id}
                  id={`settings-tab-${tab.id}`}
                  type="button"
                  role="tab"
                  aria-selected={active}
                  aria-controls="settings-tabpanel"
                  tabIndex={active ? 0 : -1}
                  onClick={() => setActiveTab(tab.id)}
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
                    setActiveTab(nextTab.id);
                    document.getElementById(`settings-tab-${nextTab.id}`)?.focus();
                  }}
                  style={{
                    position: "relative",
                    width: "100%",
                    minHeight: 40,
                    padding: isMobile ? "8px 10px" : "8px 12px",
                    border: `1px solid ${active ? "var(--accent)" : "transparent"}`,
                    borderRadius: 7,
                    background: active ? "var(--accent-soft)" : "transparent",
                    color: active ? "var(--accent)" : "var(--text-muted)",
                    fontSize: 12,
                    lineHeight: 1.35,
                    fontWeight: active ? 650 : 500,
                    textAlign: "left",
                    cursor: "pointer",
                    overflowWrap: "anywhere",
                  }}
                >
                  {tab.label}
                </button>
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
              />
            )}
            {activeTab === "browser" && <BrowserSettings sessionId={sessionId} />}
            {activeTab === "models" && <ModelsConfig embedded onClose={() => undefined} onChanged={onModelsChanged} />}
            {activeTab === "tools" && <ToolchainsConfig cwd={cwd} />}
            {activeTab === "channels" && <ChannelsConfig onSnapshotChange={onChannelsChanged} />}
            {activeTab === "skills" &&
              (cwd ? <SkillsConfig embedded cwd={cwd} onClose={() => undefined} /> : <ProjectRequired />)}
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
      </div>
    </div>
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
            <AboutRow label={t("author", "Author")} value={APP_AUTHOR} />
            <AboutRow
              label={t("officialWebsite", "Official website")}
              value={
                <button
                  type="button"
                  title={t("openOfficialWebsite", "Open official website")}
                  onClick={() => void window.piBridge.openExternal(APP_WEBSITE_URL)}
                  style={{
                    maxWidth: "100%",
                    padding: 0,
                    border: 0,
                    background: "none",
                    color: "var(--accent)",
                    fontFamily: "var(--font-mono)",
                    fontSize: 12,
                    cursor: "pointer",
                    overflowWrap: "anywhere",
                    textAlign: "right",
                  }}
                >
                  pi-desktop.app ↗
                </button>
              }
            />
            <AboutRow
              label={t("githubRepository", "GitHub repository")}
              value={
                <button
                  type="button"
                  title={t("openGithubRepository", "Open GitHub repository")}
                  onClick={() => void window.piBridge.openExternal(APP_GITHUB_URL)}
                  style={{
                    maxWidth: "100%",
                    padding: 0,
                    border: 0,
                    background: "none",
                    color: "var(--accent)",
                    fontFamily: "var(--font-mono)",
                    fontSize: 12,
                    cursor: "pointer",
                    overflowWrap: "anywhere",
                    textAlign: "right",
                  }}
                >
                  github.com/DLYZZT/pi-desktop ↗
                </button>
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
            <span
              aria-hidden="true"
              style={{
                width: 8,
                height: 8,
                marginTop: 5,
                borderRadius: "50%",
                flexShrink: 0,
                background: updateStatusColor(phase),
              }}
            />
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
              <p style={{ margin: 0, fontSize: 12, lineHeight: 1.55, color: "#f87171" }}>
                {getUpdateErrorMessage(state.error, t)}
              </p>
              <code style={{ display: "block", marginTop: 5, fontSize: 10, color: "var(--text-dim)" }}>
                {state.error.code}
              </code>
            </div>
          )}

          {actionFailed && (
            <p role="alert" style={{ margin: "12px 0 0", fontSize: 12, lineHeight: 1.55, color: "#f87171" }}>
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
          <input
            id={automaticChecksControlId}
            type="checkbox"
            aria-describedby={automaticChecksDescriptionId}
            checked={state?.automaticChecksEnabled ?? false}
            disabled={!state || phase === "disabled" || isBusy}
            onChange={(event) => {
              const enabled = event.target.checked;
              void performAction("automatic", () => window.piBridge.setAutomaticUpdateChecks(enabled));
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
    <button
      type="button"
      aria-label={label}
      aria-busy={busy || undefined}
      disabled={disabled}
      onClick={onClick}
      style={{
        minHeight: 34,
        padding: "7px 12px",
        border: `1px solid ${primary ? "var(--accent)" : "var(--border)"}`,
        borderRadius: 6,
        background: primary ? "var(--accent)" : "var(--bg)",
        color: primary ? "white" : "var(--text)",
        fontSize: 12,
        fontWeight: 600,
        cursor: disabled ? "not-allowed" : "pointer",
        opacity: disabled ? 0.6 : 1,
      }}
    >
      {label}
    </button>
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

function updateStatusColor(phase: DesktopUpdateState["phase"] | undefined): string {
  if (phase === "error") return "#f87171";
  if (phase === "available" || phase === "downloaded") return "var(--accent)";
  if (phase === "up-to-date") return "#4ade80";
  return "var(--text-dim)";
}

function displayVersion(version: string): string {
  return version.startsWith("v") ? version : `v${version}`;
}

function formatUpdateDate(value: string, language: AppLanguage): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat(language, { dateStyle: "medium", timeStyle: "short" }).format(date);
}

function formatBytes(value: number, language: AppLanguage): string {
  if (!Number.isFinite(value) || value <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const unitIndex = Math.max(0, Math.min(Math.floor(Math.log(value) / Math.log(1024)), units.length - 1));
  const amount = value / 1024 ** unitIndex;
  return `${new Intl.NumberFormat(language, { maximumFractionDigits: unitIndex === 0 ? 0 : 1 }).format(amount)} ${units[unitIndex]}`;
}

const updateDetailStyle: React.CSSProperties = {
  margin: "12px 0 0",
  fontSize: 12,
  lineHeight: 1.55,
  color: "var(--text-muted)",
};

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
}: {
  language: AppLanguage;
  onLanguageChange: (language: AppLanguage) => void;
  isDark: boolean;
  onThemeChange: (dark: boolean) => void;
}) {
  const { t } = useI18n();
  const [backgroundMode, setBackgroundMode] = useState(true);
  const [httpProxy, setHttpProxy] = useState("");
  const [httpsProxy, setHttpsProxy] = useState("");
  const [proxyLoading, setProxyLoading] = useState(true);
  const [proxySaving, setProxySaving] = useState(false);
  const [proxySaved, setProxySaved] = useState(false);
  const [proxyError, setProxyError] = useState<string | null>(null);
  const [systemProxyLoading, setSystemProxyLoading] = useState(false);
  const [proxyTesting, setProxyTesting] = useState(false);
  const [proxyTestOk, setProxyTestOk] = useState<boolean | null>(null);
  const [proxyTestMessage, setProxyTestMessage] = useState<string | null>(null);
  const languageControlId = useId();
  const backgroundModeControlId = useId();
  const themeControlId = useId();
  const httpProxyControlId = useId();
  const httpsProxyControlId = useId();
  useEffect(() => {
    void window.piBridge.getUiState().then((state) => setBackgroundMode(state.backgroundMode !== false));
  }, []);
  useEffect(() => {
    let cancelled = false;
    fetch("/api/network-proxy")
      .then((r) => r.json())
      .then((d: { httpProxy?: string; httpsProxy?: string }) => {
        if (!cancelled) {
          setHttpProxy(d.httpProxy ?? "");
          setHttpsProxy(d.httpsProxy ?? "");
        }
      })
      .catch(() => {
        if (!cancelled) setProxyError(t("proxyLoadFailed", "Failed to load proxy settings."));
      })
      .finally(() => {
        if (!cancelled) setProxyLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [t]);

  const saveProxy = async (nextHttp?: string, nextHttps?: string) => {
    setProxySaving(true);
    setProxySaved(false);
    setProxyError(null);
    try {
      const res = await fetch("/api/network-proxy", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          httpProxy: nextHttp ?? httpProxy,
          httpsProxy: nextHttps ?? httpsProxy,
        }),
      });
      const d = (await res.json()) as { ok?: boolean; error?: string };
      if (!res.ok || d.error) {
        setProxyError(d.error ?? `HTTP ${res.status}`);
        return;
      }
      setProxySaved(true);
      window.setTimeout(() => setProxySaved(false), 2500);
    } catch (e) {
      setProxyError(e instanceof Error ? e.message : String(e));
    } finally {
      setProxySaving(false);
    }
  };

  const clearProxy = async () => {
    setHttpProxy("");
    setHttpsProxy("");
    await saveProxy("", "");
  };

  const applySystemProxy = async () => {
    setProxyError(null);
    setSystemProxyLoading(true);
    try {
      const res = await fetch("/api/network-proxy/system");
      const d = (await res.json()) as { httpProxy?: string; httpsProxy?: string; error?: string };
      if (!res.ok || d.error) throw new Error(d.error ?? `HTTP ${res.status}`);
      const http = d.httpProxy ?? "";
      const https = d.httpsProxy ?? "";
      setHttpProxy(http);
      setHttpsProxy(https);
      await saveProxy(http, https);
    } catch (e) {
      setProxyError(e instanceof Error ? e.message : String(e));
    } finally {
      setSystemProxyLoading(false);
    }
  };

  const testProxyConnection = async () => {
    setProxyError(null);
    setProxyTestMessage(null);
    setProxyTestOk(null);
    setProxyTesting(true);
    try {
      const res = await fetch("/api/network-proxy/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ httpProxy, httpsProxy }),
      });
      const d = (await res.json()) as {
        ok?: boolean;
        probes?: Array<{ protocol: string; ok: boolean; latencyMs?: number; error?: string }>;
      };
      const probes = d.probes ?? [];
      const summary = probes.map((probe) => {
        const label = probe.protocol.toUpperCase();
        return probe.ok ? `${label} ${probe.latencyMs ?? 0}ms` : `${label}: ${probe.error ?? "error"}`;
      });
      if (d.ok) {
        setProxyTestOk(true);
        setProxyTestMessage(`${t("proxyTestOk", "Connection OK")}（${summary.join(" · ")}）`);
      } else if (probes.length === 0) {
        setProxyTestOk(false);
        setProxyTestMessage(t("proxyTestNoProxy", "No proxy configured to test"));
      } else {
        setProxyTestOk(false);
        setProxyTestMessage(`${t("proxyTestFailed", "Connection failed")}：${summary.join(" · ")}`);
      }
    } catch (e) {
      setProxyTestOk(false);
      setProxyTestMessage(e instanceof Error ? e.message : String(e));
    } finally {
      setProxyTesting(false);
    }
  };
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
          <select
            id={languageControlId}
            value={language}
            onChange={(event) => onLanguageChange(event.target.value as AppLanguage)}
            style={selectStyle}
          >
            <option value="en-US">English</option>
            <option value="zh-CN">简体中文</option>
          </select>
        </SettingRow>
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
            <input
              id={backgroundModeControlId}
              type="checkbox"
              checked={backgroundMode}
              onChange={(event) => {
                const next = event.target.checked;
                setBackgroundMode(next);
                void window.piBridge.setUiState({ backgroundMode: next });
              }}
              style={{ width: 18, height: 18, margin: 0, accentColor: "var(--accent)", cursor: "pointer" }}
            />
          </label>
        </SettingRow>
      </section>

      <div style={{ height: 1, background: "var(--border)", maxWidth: 620, margin: "28px 0" }} />

      <section style={{ maxWidth: 620 }}>
        <h2 style={{ margin: 0, fontSize: 14, color: "var(--text)" }}>{t("appearance", "Appearance")}</h2>
        <p style={{ margin: "6px 0 16px", fontSize: 12, lineHeight: 1.6, color: "var(--text-dim)" }}>
          {t("appearanceDescription", "Choose the color mode used by the app.")}
        </p>
        <SettingRow label={t("theme", "Theme")} controlId={themeControlId}>
          <select
            id={themeControlId}
            value={isDark ? "dark" : "light"}
            onChange={(event) => onThemeChange(event.target.value === "dark")}
            style={selectStyle}
          >
            <option value="light">{t("light", "Light")}</option>
            <option value="dark">{t("dark", "Dark")}</option>
          </select>
        </SettingRow>
      </section>

      <div style={{ height: 1, background: "var(--border)", maxWidth: 620, margin: "28px 0" }} />

      <section style={{ maxWidth: 620 }}>
        <h2 style={{ margin: 0, fontSize: 14, color: "var(--text)" }}>{t("networkProxy", "Network proxy")}</h2>
        <p style={{ margin: "6px 0 16px", fontSize: 12, lineHeight: 1.6, color: "var(--text-dim)" }}>
          {t(
            "networkProxyDescription",
            'Route model API requests and tool subprocess traffic through an HTTP(S) proxy. Leave empty for no proxy, or click "Use system settings" to apply the OS proxy.',
          )}
        </p>
        <div style={{ display: "grid", gap: 8 }}>
          <SettingRow label={t("proxyHttpUrl", "HTTP proxy URL")} controlId={httpProxyControlId}>
            <input
              id={httpProxyControlId}
              type="text"
              value={httpProxy}
              onChange={(event) => setHttpProxy(event.target.value)}
              placeholder={t("proxyEmptyHint", "No proxy (leave empty)")}
              spellCheck={false}
              style={{
                ...selectStyle,
                fontFamily: "var(--font-mono)",
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter") void saveProxy();
              }}
            />
          </SettingRow>
          <SettingRow label={t("proxyHttpsUrl", "HTTPS proxy URL")} controlId={httpsProxyControlId}>
            <input
              id={httpsProxyControlId}
              type="text"
              value={httpsProxy}
              onChange={(event) => setHttpsProxy(event.target.value)}
              placeholder={t("proxyEmptyHint", "No proxy (leave empty)")}
              spellCheck={false}
              style={{
                ...selectStyle,
                fontFamily: "var(--font-mono)",
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter") void saveProxy();
              }}
            />
          </SettingRow>
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 12 }}>
          <button
            type="button"
            onClick={() => void saveProxy()}
            disabled={proxySaving || proxyLoading}
            style={{
              height: 34,
              padding: "0 14px",
              border: "none",
              borderRadius: 5,
              background: "var(--accent)",
              color: "#fff",
              cursor: proxySaving || proxyLoading ? "not-allowed" : "pointer",
              opacity: proxySaving || proxyLoading ? 0.6 : 1,
              fontSize: 12,
              fontWeight: 600,
              flexShrink: 0,
            }}
          >
            {proxySaved ? t("saved", "Saved") : proxySaving ? t("saving", "Saving…") : t("save", "Save")}
          </button>
          <button
            type="button"
            onClick={() => void applySystemProxy()}
            disabled={proxySaving || proxyLoading || systemProxyLoading}
            style={{
              height: 34,
              padding: "0 12px",
              background: "none",
              border: "1px solid var(--border)",
              borderRadius: 5,
              color: "var(--text)",
              cursor: proxySaving || proxyLoading || systemProxyLoading ? "not-allowed" : "pointer",
              opacity: proxySaving || proxyLoading || systemProxyLoading ? 0.5 : 1,
              fontSize: 12,
              flexShrink: 0,
            }}
          >
            {systemProxyLoading ? t("checking", "Checking…") : t("useSystemProxy", "Use system settings")}
          </button>
          <button
            type="button"
            onClick={() => void testProxyConnection()}
            disabled={proxySaving || proxyLoading || proxyTesting || (!httpProxy && !httpsProxy)}
            style={{
              height: 34,
              padding: "0 12px",
              background: "none",
              border: "1px solid var(--border)",
              borderRadius: 5,
              color: "var(--text)",
              cursor:
                proxySaving || proxyLoading || proxyTesting || (!httpProxy && !httpsProxy) ? "not-allowed" : "pointer",
              opacity: proxySaving || proxyLoading || proxyTesting || (!httpProxy && !httpsProxy) ? 0.5 : 1,
              fontSize: 12,
              flexShrink: 0,
            }}
          >
            {proxyTesting ? t("testing", "Testing…") : t("testConnection", "Test connection")}
          </button>
          <button
            type="button"
            onClick={() => void clearProxy()}
            disabled={proxySaving || proxyLoading || (!httpProxy && !httpsProxy)}
            style={{
              height: 34,
              padding: "0 12px",
              background: "none",
              border: "1px solid rgba(239,68,68,0.3)",
              borderRadius: 5,
              color: "#ef4444",
              cursor: proxySaving || proxyLoading || (!httpProxy && !httpsProxy) ? "not-allowed" : "pointer",
              opacity: proxySaving || proxyLoading || (!httpProxy && !httpsProxy) ? 0.5 : 1,
              fontSize: 12,
              flexShrink: 0,
            }}
          >
            {t("clearProxy", "Clear")}
          </button>
        </div>
        {proxyTestMessage && (
          <div
            style={{
              fontSize: 12,
              color: proxyTestOk ? "#16a34a" : "#f87171",
              marginTop: 8,
              wordBreak: "break-all",
            }}
          >
            {proxyTestMessage}
          </div>
        )}
        {proxyError && <div style={{ fontSize: 12, color: "#f87171", marginTop: 8 }}>{proxyError}</div>}
        <p style={{ margin: "8px 0 0", fontSize: 11, lineHeight: 1.5, color: "var(--text-dim)" }}>
          {t(
            "networkProxyNote",
            "HTTPS requests fall back to the HTTP proxy when HTTPS is left empty. Applies to new agent sessions.",
          )}
        </p>
      </section>
    </div>
  );
}

function SettingRow({ label, controlId, children }: { label: string; controlId: string; children: React.ReactNode }) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: 20,
        minHeight: 52,
        padding: "10px 12px",
        border: "1px solid var(--border)",
        borderRadius: 8,
        background: "var(--bg-panel)",
      }}
    >
      <label htmlFor={controlId} style={{ fontSize: 13, color: "var(--text-muted)", cursor: "pointer" }}>
        {label}
      </label>
      {children}
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

const selectStyle: React.CSSProperties = {
  minWidth: 160,
  minHeight: 36,
  padding: "7px 30px 7px 10px",
  border: "1px solid var(--border)",
  borderRadius: 6,
  background: "var(--bg)",
  color: "var(--text)",
  fontSize: 13,
  cursor: "pointer",
};
