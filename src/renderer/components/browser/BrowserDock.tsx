import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  ArrowLeft,
  ArrowRight,
  ExternalLink,
  Globe,
  LoaderCircle,
  Monitor,
  MoreHorizontal,
  Plus,
  RotateCw,
  Smartphone,
  Upload,
  X,
} from "lucide-react";
import { BrowserDeviceToolbar } from "./BrowserDeviceToolbar";
import type { BrowserDeviceModeInput } from "../../../contract/browser-device";
import { Input } from "@/components/ui/Input";
import { useI18n } from "@/i18n";
import { browserErrorMessage as messageOf } from "./browser-error-message";
import { browserSurfaceBounds } from "./browser-surface-bounds";
import type {
  BrowserDownloadInfo,
  BrowserEvent,
  BrowserPermissionRequest,
  BrowserRendererState,
  BrowserTabInfo,
} from "../../../contract/browser";
import { Button } from "@/components/ui/Button";
import { Select } from "@/components/ui/Select";

export function BrowserDock({ visible, ownerSessionId }: { visible: boolean; ownerSessionId: string | null }) {
  const { t } = useI18n();
  const [moreOpen, setMoreOpen] = useState(false);
  const [presetOpen, setPresetOpen] = useState(false);
  const [profileOpen, setProfileOpen] = useState(false);
  const [changingDevice, setChangingDevice] = useState(false);
  const [state, setState] = useState<BrowserRendererState | null>(null);
  const [address, setAddress] = useState("");
  const [profileId, setProfileId] = useState("temporary");
  const [error, setError] = useState("");
  const surfaceRef = useRef<HTMLDivElement>(null);
  const moreRef = useRef<HTMLDivElement>(null);
  const moreButtonRef = useRef<HTMLButtonElement>(null);
  const stateRef = useRef(state);
  stateRef.current = state;
  const refreshGenerationRef = useRef(0);

  // A tab is presentable in this conversation when it is shared (ownerless) or
  // owned by the selected session. The global active tab can belong to another
  // conversation; that tab must never drive this panel's chrome or surface.
  const isVisibleTab = useCallback(
    (tab: BrowserTabInfo) => tab.ownerSessionId === null || tab.ownerSessionId === ownerSessionId,
    [ownerSessionId],
  );

  const refresh = useCallback(async () => {
    const generation = ++refreshGenerationRef.current;
    try {
      const next = await window.piBridge.browserGetState();
      // A conversation switch can issue a newer refresh while this one is in
      // flight; only the latest response may overwrite the panel.
      if (generation !== refreshGenerationRef.current) return;
      if (!stateRef.current) setProfileId(next.settings.settings.panel.defaultProfileId);
      setState(next);
      const active = next.tabs.find((tab) => tab.id === next.activeTabId);
      setAddress(active && isVisibleTab(active) ? active.url : "");
      setError("");
    } catch (cause) {
      if (generation !== refreshGenerationRef.current) return;
      setError(messageOf(cause));
    }
  }, [isVisibleTab]);

  const handleTabSyncError = useCallback(
    (cause: unknown) => {
      const message = messageOf(cause);
      if (message.includes("TAB_NOT_FOUND")) {
        void refresh();
        return;
      }
      setError(message);
    },
    [refresh],
  );

  useEffect(() => {
    void refresh();
    return window.piBridge.onBrowserEvent((event) => {
      setState((current) => (current ? applyBrowserEvent(current, event) : current));
      if (event.type === "active-tab-changed") {
        setMoreOpen(false);
        const previous = stateRef.current?.tabs.find((candidate) => candidate.id === stateRef.current?.activeTabId);
        const next = stateRef.current?.tabs.find((candidate) => candidate.id === event.tabId);
        const previousUrl = previous && isVisibleTab(previous) ? previous.url : "";
        const nextUrl = next && isVisibleTab(next) ? next.url : "";
        // Keep a URL the user is still typing unless it was the old tab's URL.
        setAddress((current) => (current !== "" && current !== previousUrl ? current : nextUrl));
      } else if (event.type === "tab-updated" && event.tab.id === stateRef.current?.activeTabId) {
        // Foreign tabs keep updating in the background; they must not wipe an
        // address the user is typing for this conversation.
        if (isVisibleTab(event.tab)) setAddress(event.tab.url);
      }
    });
  }, [isVisibleTab, refresh]);

  const visibleTabs = state?.tabs.filter(isVisibleTab) ?? [];
  const activeTab = visibleTabs.find((tab) => tab.id === state?.activeTabId) ?? null;
  const device = activeTab?.device?.mode === "mobile" ? activeTab.device : null;
  const run = (action: Promise<unknown>) => void action.catch(handleTabSyncError);
  const changeDevice = async (input: BrowserDeviceModeInput) => {
    if (!activeTab || changingDevice) return;
    setChangingDevice(true);
    setError("");
    try {
      await window.piBridge.browserSetDeviceMode(activeTab.id, input, ownerSessionId);
    } catch (cause) {
      handleTabSyncError(cause);
    } finally {
      setChangingDevice(false);
    }
  };

  useEffect(() => {
    if (!state || !visible || !state.activeTabId) return;
    const active = state.tabs.find((tab) => tab.id === state.activeTabId);
    if (!active || isVisibleTab(active)) return;
    // Showing another conversation's native view would leak its page into this
    // panel. Switch to this conversation's most recent tab instead; when there
    // is none the visibility effect below keeps the surface hidden.
    const replacement = [...state.tabs]
      .filter(isVisibleTab)
      .sort((left, right) => right.lastActiveAt - left.lastActiveAt)[0];
    if (replacement) {
      void window.piBridge.browserActivateTab(replacement.id, ownerSessionId).catch(handleTabSyncError);
    }
  }, [handleTabSyncError, isVisibleTab, ownerSessionId, state, visible]);

  useEffect(() => {
    const tabId = activeTab?.id;
    void window.piBridge
      .browserSetSurfaceVisible(
        {
          ...(tabId ? { tabId } : {}),
          visible: visible && Boolean(tabId) && !presetOpen && !moreOpen,
        },
        ownerSessionId,
      )
      .catch(handleTabSyncError);
    return () => {
      void window.piBridge.browserSetSurfaceVisible({ visible: false }).catch(() => undefined);
    };
  }, [activeTab?.id, handleTabSyncError, moreOpen, ownerSessionId, presetOpen, visible]);

  useEffect(() => {
    if (!moreOpen) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !profileOpen) {
        setMoreOpen(false);
        moreButtonRef.current?.focus();
      }
    };
    const closeOnOutside = (event: MouseEvent | FocusEvent) => {
      if (!profileOpen && event.target instanceof Node && !moreRef.current?.contains(event.target)) setMoreOpen(false);
    };
    window.addEventListener("keydown", closeOnEscape);
    document.addEventListener("mousedown", closeOnOutside);
    document.addEventListener("focusin", closeOnOutside);
    return () => {
      window.removeEventListener("keydown", closeOnEscape);
      document.removeEventListener("mousedown", closeOnOutside);
      document.removeEventListener("focusin", closeOnOutside);
    };
  }, [moreOpen, profileOpen]);

  useLayoutEffect(() => {
    const element = surfaceRef.current;
    const tabId = activeTab?.id;
    if (!element || !tabId || !visible) return;
    let frame = 0;
    let lastBoundsKey = "";
    const panel = element.closest(".right-panel-container");
    const sync = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const surfaceRect = element.getBoundingClientRect();
        const rect = browserSurfaceBounds(surfaceRect, panel?.getBoundingClientRect() ?? surfaceRect);
        if (!rect) return;
        const scaleFactorVersion = Math.round(window.devicePixelRatio * 1000);
        const key = `${rect.x}:${rect.y}:${rect.width}:${rect.height}:${scaleFactorVersion}`;
        if (key === lastBoundsKey) return;
        lastBoundsKey = key;
        void window.piBridge
          .browserSetBounds(
            {
              tabId,
              rect,
              scaleFactorVersion,
            },
            ownerSessionId,
          )
          .catch((cause) => {
            if (lastBoundsKey === key) lastBoundsKey = "";
            handleTabSyncError(cause);
          });
      });
    };
    const observer = new ResizeObserver(sync);
    observer.observe(element);
    if (panel) observer.observe(panel);
    window.addEventListener("resize", sync);
    window.addEventListener("scroll", sync, true);
    // A flex layout can move the panel without resizing the surface. Native
    // WebContentsView bounds need that position change even after CSS settles.
    const positionCheck = window.setInterval(sync, 120);
    sync();
    return () => {
      cancelAnimationFrame(frame);
      window.clearInterval(positionCheck);
      observer.disconnect();
      window.removeEventListener("resize", sync);
      window.removeEventListener("scroll", sync, true);
    };
  }, [activeTab?.id, handleTabSyncError, ownerSessionId, visible]);

  const createTab = async (url?: string) => {
    try {
      const tab = await window.piBridge.browserCreateUserTab({
        profileId,
        ownerSessionId,
        activate: true,
        ...(url ? { url } : {}),
      });
      setAddress(tab.url);
      await refresh();
    } catch (cause) {
      setError(messageOf(cause));
    }
  };

  const navigate = async () => {
    const target = address.trim();
    if (!target) return;
    if (!activeTab) {
      // The address bar stays usable in a conversation without a tab: Enter
      // opens a tab owned by this conversation instead of driving a foreign one.
      await createTab(target);
      return;
    }
    try {
      await window.piBridge.browserNavigateUser(activeTab.id, target, ownerSessionId);
    } catch (cause) {
      setError(messageOf(cause));
    }
  };

  if (!state) return <div style={emptyStyle}>{error || t("browserLoadingPanel", "Loading Browser…")}</div>;
  if (!state.settings.settings.enabled) {
    return (
      <div style={emptyStyle}>
        <div>{t("browserDisabled", "Built-in Browser is disabled.")}</div>
        <div style={{ marginTop: 7, color: "var(--text-dim)" }}>
          {t("browserEnableInSettings", "Enable it in Settings → Browser.")}
        </div>
      </div>
    );
  }

  return (
    <div className="browser-dock">
      <div className="browser-tab-strip" role="tablist" aria-label={t("browserTabs", "Browser tabs")}>
        {visibleTabs.map((tab) => (
          <div className={`browser-tab${tab.id === state.activeTabId ? " is-active" : ""}`} key={tab.id}>
            <Button
              role="tab"
              aria-selected={tab.id === state.activeTabId}
              className="browser-tab-select"
              size="sm"
              style={{ minWidth: 0, padding: "0 7px", fontSize: 11, minHeight: 28 }}
              title={tab.url}
              onClick={() => run(window.piBridge.browserActivateTab(tab.id, ownerSessionId))}
              variant="ghost"
            >
              {tab.loading ? (
                <LoaderCircle className="is-spinning" size={13} aria-label={t("browserLoading", "Loading")} />
              ) : (
                <Globe size={13} aria-hidden="true" />
              )}
              <span className="browser-tab-title">{tab.title || t("browserNewTab", "New tab")}</span>
              {tab.advanced || tab.advancedProfile ? (
                <Badge danger>{t("browserAdvancedModeBadge", "Advanced Browser Mode")}</Badge>
              ) : null}
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="browser-chrome-icon browser-tab-close"
              aria-label={t("browserCloseTab", "Close tab")}
              title={t("browserCloseTab", "Close tab")}
              onClick={() => run(window.piBridge.browserCloseTab(tab.id, ownerSessionId))}
            >
              <X size={13} aria-hidden="true" />
            </Button>
          </div>
        ))}
        <Button
          variant="ghost"
          size="icon"
          className="browser-chrome-icon"
          title={t("browserNewTab", "New tab")}
          aria-label={t("browserNewTab", "New tab")}
          onClick={() => void createTab()}
        >
          <Plus size={15} aria-hidden="true" />
        </Button>
      </div>

      <div className="browser-navigation-bar">
        <Button
          variant="ghost"
          size="icon"
          className="browser-chrome-icon"
          disabled={!activeTab?.canGoBack}
          title={t("browserBack", "Back")}
          aria-label={t("browserBack", "Back")}
          onClick={() => activeTab && run(window.piBridge.browserGoBack(activeTab.id, ownerSessionId))}
        >
          <ArrowLeft size={15} aria-hidden="true" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="browser-chrome-icon"
          disabled={!activeTab?.canGoForward}
          title={t("browserForward", "Forward")}
          aria-label={t("browserForward", "Forward")}
          onClick={() => activeTab && run(window.piBridge.browserGoForward(activeTab.id, ownerSessionId))}
        >
          <ArrowRight size={15} aria-hidden="true" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="browser-chrome-icon"
          disabled={!activeTab}
          title={activeTab?.loading ? t("browserStop", "Stop") : t("browserReload", "Reload")}
          aria-label={activeTab?.loading ? t("browserStop", "Stop") : t("browserReload", "Reload")}
          onClick={() =>
            activeTab &&
            run(
              activeTab.loading
                ? window.piBridge.browserStop(activeTab.id, ownerSessionId)
                : window.piBridge.browserReload(activeTab.id, ownerSessionId),
            )
          }
        >
          {activeTab?.loading ? <X size={15} aria-hidden="true" /> : <RotateCw size={14} aria-hidden="true" />}
        </Button>
        <form
          className="browser-address-form"
          onSubmit={(event) => {
            event.preventDefault();
            void navigate();
          }}
        >
          <Input
            size="sm"
            aria-label={t("browserAddress", "Browser address")}
            value={address}
            onChange={(event) => setAddress(event.target.value)}
            placeholder="https://example.com"
          />
        </form>
        <Button
          variant={device ? "primary" : "ghost"}
          size="icon"
          className="browser-chrome-icon"
          pressed={Boolean(device)}
          disabled={!activeTab}
          title={device ? t("browserDeviceDesktop", "Exit device mode") : t("browserDeviceMode", "Device mode")}
          aria-label={device ? t("browserDeviceDesktop", "Exit device mode") : t("browserDeviceMode", "Device mode")}
          onClick={() => void changeDevice(device ? { mode: "desktop" } : { mode: "preset", presetId: "galaxy-a55" })}
        >
          {device ? <Monitor size={15} aria-hidden="true" /> : <Smartphone size={15} aria-hidden="true" />}
        </Button>
        <div className="browser-more-anchor" ref={moreRef}>
          <Button
            ref={moreButtonRef}
            variant="ghost"
            size="icon"
            className="browser-chrome-icon"
            title={t("browserMoreActions", "More browser actions")}
            aria-label={t("browserMoreActions", "More browser actions")}
            aria-expanded={moreOpen}
            onClick={() => setMoreOpen((open) => !open)}
          >
            <MoreHorizontal size={16} aria-hidden="true" />
          </Button>
          {moreOpen && (
            <div
              className="browser-more-menu"
              role="group"
              aria-label={t("browserMoreActions", "More browser actions")}
            >
              <Select
                size="sm"
                aria-label={t("browserProfileForNewTabs", "Profile for new tabs")}
                value={profileId}
                onChange={setProfileId}
                onOpenChange={setProfileOpen}
                options={state.profiles.map((profile) => ({ value: profile.id, label: profile.name }))}
              />
              <Button
                variant="ghost"
                size="sm"
                style={{ justifyContent: "flex-start", textAlign: "left" }}
                className="browser-more-item"
                disabled={!activeTab}
                onClick={() => {
                  setMoreOpen(false);
                  if (activeTab) run(window.piBridge.browserChooseUploadFiles(activeTab.id, ownerSessionId));
                }}
              >
                <Upload size={15} aria-hidden="true" />
                {t("browserChooseUpload", "Choose files for focused upload input")}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                style={{ justifyContent: "flex-start", textAlign: "left" }}
                className="browser-more-item"
                disabled={!activeTab || !/^https?:/.test(activeTab.url)}
                onClick={() => {
                  if (activeTab) run(window.piBridge.openExternal(activeTab.url));
                  setMoreOpen(false);
                }}
              >
                <ExternalLink size={15} aria-hidden="true" />
                {t("browserOpenSystem", "Open in system browser")}
              </Button>
            </div>
          )}
        </div>
      </div>
      {device && (
        <BrowserDeviceToolbar
          key={`${activeTab?.id}:${device.presetId}:${device.orientation}:${device.width}:${device.height}:${device.dpr}:${device.touch}`}
          device={device}
          busy={changingDevice}
          onChange={(input) => void changeDevice(input)}
          onOpenChange={setPresetOpen}
        />
      )}

      {(error || state.permissionRequests.length > 0 || activeDownload(state.downloads)) && (
        <div
          style={{
            display: "grid",
            gap: 4,
            padding: "5px 7px",
            borderBottom: "1px solid var(--border)",
            background: "var(--bg-panel)",
            fontSize: 10,
          }}
        >
          {error && <div style={{ color: "var(--danger)" }}>{error}</div>}
          {state.permissionRequests.map((request) => (
            <PermissionPrompt key={request.id} request={request} onRespond={refresh} />
          ))}
          {activeDownload(state.downloads) && <DownloadStatus download={activeDownload(state.downloads)!} />}
        </div>
      )}

      {!activeTab ? (
        <div style={emptyStyle}>
          <Button style={primaryButtonStyle} onClick={() => void createTab()}>
            {t("browserOpenNewTab", "Open a new tab")}
          </Button>
          <div style={{ marginTop: 8, color: "var(--text-dim)" }}>
            {t("browserRemotePageSecurity", "Remote pages receive no Pi Desktop preload or Node access.")}
          </div>
        </div>
      ) : activeTab.crashed ? (
        <div style={emptyStyle}>
          <div>{t("browserTabCrashed", "This tab’s renderer crashed.")}</div>
          <Button
            style={{ ...primaryButtonStyle, marginTop: 9 }}
            onClick={() => void window.piBridge.browserReload(activeTab.id, ownerSessionId)}
          >
            {t("browserReload", "Reload")}
          </Button>
        </div>
      ) : (
        <div ref={surfaceRef} data-browser-surface />
      )}

      {activeTab && (
        <div
          style={{
            minHeight: 22,
            display: "flex",
            alignItems: "center",
            gap: 6,
            padding: "0 7px",
            borderTop: "1px solid var(--border)",
            color: "var(--text-dim)",
            fontSize: 9,
            background: "var(--bg-panel)",
          }}
        >
          <span>
            {activeTab.control === "agent"
              ? t("browserAgentControl", "Agent is controlling this tab — click or type to take over")
              : t("browserUserControl", "User control")}
          </span>
          <span>·</span>
          <span>
            {state.settings.settings.navigation.networkIsolation === "strict"
              ? t("browserStrictIsolation", "Strict isolation")
              : t("browserBestEffortIsolation", "Best-effort network isolation")}
          </span>
          {activeTab.advanced || activeTab.advancedProfile ? (
            <Badge danger>{t("browserAdvancedModeBadge", "Advanced Browser Mode")}</Badge>
          ) : null}
        </div>
      )}
    </div>
  );
}

function PermissionPrompt({
  request,
  onRespond,
}: {
  request: BrowserPermissionRequest;
  onRespond: () => Promise<void>;
}) {
  const { t } = useI18n();
  const respond = (decision: "allow-once" | "allow-session" | "deny") =>
    void window.piBridge.browserRespondPermission(request.id, decision).then(onRespond);
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 6, color: "var(--text-muted)" }}>
      <span style={{ flex: 1 }}>
        {formatMessage(t("browserPermissionRequest", "{origin} requests {permission}"), {
          origin: request.origin,
          permission: request.permission,
        })}
      </span>
      <Button style={tinyButtonStyle} onClick={() => respond("deny")}>
        {t("browserDeny", "Deny")}
      </Button>
      <Button style={tinyButtonStyle} onClick={() => respond("allow-once")}>
        {t("browserAllowOnce", "Once")}
      </Button>
      <Button style={tinyButtonStyle} onClick={() => respond("allow-session")}>
        {t("browserAllowSession", "Session")}
      </Button>
    </div>
  );
}

function DownloadStatus({ download }: { download: BrowserDownloadInfo }) {
  const { t } = useI18n();
  const percent = download.totalBytes > 0 ? Math.round((download.receivedBytes / download.totalBytes) * 100) : null;
  const stateLabel = downloadStateLabel(t, download.state);
  return (
    <div style={{ color: download.state === "interrupted" ? "var(--danger)" : "var(--text-dim)" }}>
      {formatMessage(t("browserDownloadStatus", "Download {filename}: {state}{percent}"), {
        filename: download.filename,
        state: stateLabel,
        percent: percent === null ? "" : ` ${percent}%`,
      })}
    </div>
  );
}

function Badge({ children, danger }: { children: string; danger?: boolean }) {
  return (
    <span
      style={{
        padding: "1px 3px",
        borderRadius: 3,
        color: danger ? "var(--danger)" : "var(--warning)",
        border: `1px solid ${danger ? "var(--danger)" : "var(--warning)"}`,
        fontSize: 7,
        fontWeight: 700,
      }}
    >
      {children}
    </span>
  );
}

function activeDownload(downloads: BrowserDownloadInfo[]): BrowserDownloadInfo | undefined {
  return [...downloads]
    .reverse()
    .find(
      (download) =>
        download.state === "pending" || download.state === "progressing" || download.state === "interrupted",
    );
}

type Translate = ReturnType<typeof useI18n>["t"];

function formatMessage(template: string, values: Record<string, string | number>): string {
  return Object.entries(values).reduce(
    (message, [key, value]) => message.replaceAll(`{${key}}`, String(value)),
    template,
  );
}

function downloadStateLabel(t: Translate, state: BrowserDownloadInfo["state"]): string {
  switch (state) {
    case "pending":
      return t("browserDownloadPending", "pending");
    case "progressing":
      return t("browserDownloadProgressing", "progressing");
    case "completed":
      return t("browserDownloadCompleted", "completed");
    case "cancelled":
      return t("browserDownloadCancelled", "cancelled");
    default:
      return t("browserDownloadInterrupted", "interrupted");
  }
}

function applyBrowserEvent(state: BrowserRendererState, event: BrowserEvent): BrowserRendererState {
  if (event.type === "tab-created") return { ...state, tabs: [...state.tabs, event.tab] };
  if (event.type === "tab-updated")
    return { ...state, tabs: state.tabs.map((tab) => (tab.id === event.tab.id ? event.tab : tab)) };
  if (event.type === "tab-closed")
    return {
      ...state,
      tabs: state.tabs.filter((tab) => tab.id !== event.tabId),
      activeTabId: state.activeTabId === event.tabId ? null : state.activeTabId,
    };
  if (event.type === "active-tab-changed") return { ...state, activeTabId: event.tabId };
  if (event.type === "permission-request")
    return {
      ...state,
      permissionRequests: [
        ...state.permissionRequests.filter((request) => request.id !== event.request.id),
        event.request,
      ],
    };
  if (event.type === "permission-resolved")
    return {
      ...state,
      permissionRequests: state.permissionRequests.filter((request) => request.id !== event.requestId),
    };
  if (event.type === "download")
    return {
      ...state,
      downloads: [...state.downloads.filter((download) => download.id !== event.download.id), event.download].slice(
        -100,
      ),
    };
  if (event.type === "policy-changed")
    return {
      ...state,
      capabilities: event.snapshot,
      settings: { ...state.settings, runtime: { ...state.settings.runtime, policyRevision: event.revision } },
    };
  return state;
}

const emptyStyle = {
  height: "100%",
  display: "flex",
  flexDirection: "column" as const,
  alignItems: "center",
  justifyContent: "center",
  padding: 18,
  textAlign: "center" as const,
  color: "var(--text-muted)",
  fontSize: 11,
};
const primaryButtonStyle = {
  minHeight: 32,
  padding: "0 12px",
  borderRadius: 6,
  fontSize: 11,
  // Accent-tinted call-to-action identity; hover feedback comes from the shared
  // pi-btn class.
  background: "var(--accent-soft)",
  borderColor: "var(--accent)",
  color: "var(--accent)",
};
const tinyButtonStyle = {
  minHeight: 22,
  padding: "0 6px",
  borderRadius: 4,
  fontSize: 9,
};
