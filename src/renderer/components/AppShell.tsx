import { listSessions } from "@/lib/api-client";
import {
  useState,
  useCallback,
  useRef,
  useEffect,
  useSyncExternalStore,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { SessionSidebar } from "./SessionSidebar";
import { ChatWindow } from "./ChatWindow";
import { FileExplorer } from "./FileExplorer";
import { FileViewer } from "./FileViewer";
import { TabBar, type Tab } from "./TabBar";
import { SettingsConfig } from "./SettingsConfig";
import { useTheme } from "@/hooks/useTheme";
import { useIsMobile } from "@/hooks/useIsMobile";
import { useI18n } from "@/i18n";
import { copyText } from "@/lib/clipboard";
import { getFileName } from "@/lib/file-paths";
import { buildAtMentionText } from "@/lib/file-fuzzy";
import type { SessionInfo } from "@/lib/types";
import type { ChatInputHandle } from "./ChatInput";
import type { SessionStatsInfo } from "@/lib/pi-types";

type SessionCopyField = "file" | "id";
const EXPLORER_TAB_ID = "explorer";
const RIGHT_PANEL_WIDTH_KEY = "pi-desktop:right-panel-width:v2";

function initialRightPanelWidth(): number {
  try {
    const stored = Number(localStorage.getItem(RIGHT_PANEL_WIDTH_KEY));
    if (Number.isFinite(stored) && stored >= 280) return stored;
  } catch {
    // Storage can be unavailable in privacy-restricted renderer contexts.
  }
  return 360;
}

function useSearchParamsCompat() {
  const subscribe = (cb: () => void) => {
    window.addEventListener("popstate", cb);
    return () => window.removeEventListener("popstate", cb);
  };
  const get = () => window.location.search;
  const search = useSyncExternalStore(subscribe, get, () => "");
  return new URLSearchParams(search);
}

function useRouterCompat() {
  return {
    replace: (url: string, _opts?: { scroll?: boolean }) => {
      const next = url.startsWith("?") || url.startsWith("/") ? url : `?${url}`;
      const full = next.startsWith("?") ? `${window.location.pathname}${next}` : next;
      window.history.replaceState(null, "", full === "/" ? "/" : full);
      window.dispatchEvent(new Event("popstate"));
    },
  };
}

export function AppShell() {
  const router = useRouterCompat();
  const searchParams = useSearchParamsCompat();
  const { isDark, toggleTheme } = useTheme();
  const { language, t } = useI18n();
  const isMobile = useIsMobile();
  const [selectedSession, setSelectedSession] = useState<SessionInfo | null>(null);
  // When user clicks +, we only store the cwd — no fake session id
  const [newSessionCwd, setNewSessionCwd] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [sessionKey, setSessionKey] = useState(0);
  const [explorerRefreshKey, setExplorerRefreshKey] = useState(0);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [modelsRefreshKey, setModelsRefreshKey] = useState(0);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [mobileSidebarReady, setMobileSidebarReady] = useState(false);
  // On mobile the sidebar is an overlay drawer; hide it by default so the chat
  // is visible on load. Runs once the breakpoint resolves after hydration.
  useEffect(() => {
    if (isMobile) setSidebarOpen(false);
  }, [isMobile]);
  useEffect(() => {
    setMobileSidebarReady(true);
  }, []);
  const chatInputRef = useRef<ChatInputHandle | null>(null);

  // Session stats (tokens + cost) — populated by ChatWindow, displayed in top bar
  const [sessionStats, setSessionStats] = useState<SessionStatsInfo | null>(null);
  const handleSessionStatsChange = useCallback((stats: SessionStatsInfo | null) => {
    setSessionStats(stats);
  }, []);
  const [copiedSessionField, setCopiedSessionField] = useState<SessionCopyField | null>(null);
  const sessionCopyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const handleCopySessionField = useCallback((field: SessionCopyField, value: string) => {
    void copyText(value).then(() => {
      if (sessionCopyTimerRef.current) clearTimeout(sessionCopyTimerRef.current);
      setCopiedSessionField(field);
      sessionCopyTimerRef.current = setTimeout(() => setCopiedSessionField(null), 1400);
    });
  }, []);

  useEffect(() => {
    return () => {
      if (sessionCopyTimerRef.current) clearTimeout(sessionCopyTimerRef.current);
    };
  }, []);

  // Context usage — populated by ChatWindow, displayed in top bar
  const [contextUsage, setContextUsage] = useState<{
    percent: number | null;
    contextWindow: number;
    tokens: number | null;
  } | null>(null);
  const handleContextUsageChange = useCallback(
    (usage: { percent: number | null; contextWindow: number; tokens: number | null } | null) => {
      setContextUsage(usage);
    },
    [],
  );

  const [activeTopPanel, setActiveTopPanel] = useState<"session" | null>(null);

  const toggleTopPanel = useCallback(() => {
    if (isMobile) setSidebarOpen(false);
    setActiveTopPanel((cur) => (cur === "session" ? null : "session"));
  }, [isMobile]);

  const openSessionStatsPanel = useCallback(() => {
    if (isMobile) setSidebarOpen(false);
    setActiveTopPanel("session");
  }, [isMobile]);

  const handleSidebarToggle = useCallback(() => {
    if (isMobile) setActiveTopPanel(null);
    setSidebarOpen((open) => !open);
  }, [isMobile]);

  // Right panel — file tabs only
  const [fileTabs, setFileTabs] = useState<Tab[]>([]);
  const [activeFileTabId, setActiveFileTabId] = useState<string | null>(EXPLORER_TAB_ID);
  const [rightPanelOpen, setRightPanelOpen] = useState(false);
  const [rightPanelWidth, setRightPanelWidth] = useState(initialRightPanelWidth);
  const [rightPanelResizing, setRightPanelResizing] = useState(false);
  const rightPanelResizeCleanupRef = useRef<(() => void) | null>(null);

  const handleRightPanelResizeStart = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (isMobile || event.button !== 0) return;
      event.preventDefault();
      rightPanelResizeCleanupRef.current?.();

      const startX = event.clientX;
      const startWidth = rightPanelWidth;
      let finalWidth = startWidth;
      const maxWidth = () => Math.max(280, window.innerWidth - (sidebarOpen ? 280 : 0) - 420);

      const handleMove = (moveEvent: PointerEvent) => {
        finalWidth = Math.min(maxWidth(), Math.max(280, startWidth + startX - moveEvent.clientX));
        setRightPanelWidth(finalWidth);
      };
      const cleanup = () => {
        window.removeEventListener("pointermove", handleMove);
        window.removeEventListener("pointerup", cleanup);
        window.removeEventListener("pointercancel", cleanup);
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
        setRightPanelResizing(false);
        rightPanelResizeCleanupRef.current = null;
        try {
          localStorage.setItem(RIGHT_PANEL_WIDTH_KEY, String(Math.round(finalWidth)));
        } catch {
          // Ignore storage failures; resizing still works for this session.
        }
      };

      rightPanelResizeCleanupRef.current = cleanup;
      setRightPanelResizing(true);
      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";
      window.addEventListener("pointermove", handleMove);
      window.addEventListener("pointerup", cleanup);
      window.addEventListener("pointercancel", cleanup);
    },
    [isMobile, rightPanelWidth, sidebarOpen],
  );

  useEffect(() => () => rightPanelResizeCleanupRef.current?.(), []);

  useEffect(() => {
    if (isMobile) return;
    const fitToWindow = () => {
      const maxWidth = Math.max(280, window.innerWidth - (sidebarOpen ? 280 : 0) - 420);
      setRightPanelWidth((width) => Math.min(width, maxWidth));
    };
    fitToWindow();
    window.addEventListener("resize", fitToWindow);
    return () => window.removeEventListener("resize", fitToWindow);
  }, [isMobile, sidebarOpen]);

  // Same @mention format as the chat input's @ autocomplete, so the agent's
  // read tool resolves it the same way (it strips the @ prefix).
  const handleAtMention = useCallback((relativePath: string, isDir: boolean) => {
    chatInputRef.current?.insertText(buildAtMentionText(relativePath, isDir));
  }, []);

  const [initialSessionId] = useState<string | null>(() => searchParams.get("session"));
  const [activeCwd, setActiveCwd] = useState<string | null>(null);
  // True once the initial ?session= URL param has been resolved (or confirmed absent)
  const [initialSessionRestored, setInitialSessionRestored] = useState<boolean>(() => !searchParams.get("session"));
  // Suppresses sessionKey bump in handleCwdChange during the initial URL restore
  const suppressCwdBumpRef = useRef(false);

  // Deep link + menu actions from Electron main
  useEffect(() => {
    const offDeep = window.piBridge?.onDeepLinkSession?.((sessionId) => {
      void (async () => {
        try {
          const { sessions } = await listSessions();
          const found = sessions.find((s) => s.id === sessionId);
          if (found) {
            setNewSessionCwd(null);
            setSelectedSession(found as SessionInfo);
            setSessionKey((k) => k + 1);
            setRefreshKey((k) => k + 1);
            router.replace(`?session=${encodeURIComponent(sessionId)}`);
          }
        } catch (error) {
          console.error("deep link open failed", error);
        }
      })();
    });
    const offNew = window.piBridge?.onMenu?.("new-session", () => {
      if (activeCwd) {
        setSelectedSession(null);
        setNewSessionCwd(activeCwd);
        setSessionKey((k) => k + 1);
      }
    });
    const offSettings = window.piBridge?.onMenu?.("settings", () => {
      setSettingsOpen(true);
    });
    // ISSUE-016: Switch Session palette — focus sidebar / open project list
    const offSwitch = window.piBridge?.onMenu?.("switch-session", () => {
      setSidebarOpen(true);
      // Nudge sidebar to refresh sessions
      setRefreshKey((k) => k + 1);
    });
    return () => {
      offDeep?.();
      offNew?.();
      offSettings?.();
      offSwitch?.();
    };
  }, [activeCwd, router]);

  const handleCwdChange = useCallback(
    (cwd: string | null, projectRoot?: string | null) => {
      setActiveCwd(cwd);
      // Skip if cwd is null (initial mount) or during the initial URL restore.
      if (!cwd) return;
      if (suppressCwdBumpRef.current) {
        suppressCwdBumpRef.current = false;
        return;
      }
      // Worktrees of one repo share a project root. Moving the effective cwd
      // within the same project (e.g. switching worktree, or clicking a session
      // that lives in another worktree) must not close the open session.
      const newProject = projectRoot ?? cwd;
      if (selectedSession && (selectedSession.projectRoot ?? selectedSession.cwd) === newProject) {
        return;
      }
      // Close any session that belongs to a different project — it no longer
      // matches the selected project directory.
      setSelectedSession(null);
      setNewSessionCwd((prev) => {
        if (prev && prev !== cwd) return null;
        return prev;
      });
      setSessionKey((k) => k + 1);
      setActiveTopPanel(null);
      router.replace("/", { scroll: false });
    },
    [router, selectedSession],
  );

  const handleSelectSession = useCallback(
    (session: SessionInfo, isRestore = false) => {
      setNewSessionCwd(null);
      setSelectedSession(session);
      setSessionKey((k) => k + 1);
      setInitialSessionRestored(true);
      // On mobile, collapse the overlay drawer so the chat is revealed after pick.
      if (isMobile && !isRestore) setSidebarOpen(false);
      if (isRestore) {
        // Suppress the redundant sessionKey bump that would come from the
        // onCwdChange effect firing after setSelectedCwd in the sidebar
        suppressCwdBumpRef.current = true;
      }
      // Skip router.replace when restoring from URL — the param is already correct
      // and replacing it during the initial desktop restore causes a remount loop
      if (!isRestore) {
        router.replace(`?session=${encodeURIComponent(session.id)}`, { scroll: false });
      }
    },
    [router, isMobile],
  );

  const handleNewSession = useCallback(
    (_sessionId: string, cwd: string) => {
      setSelectedSession(null);
      setNewSessionCwd(cwd);
      setSessionKey((k) => k + 1);
      setActiveTopPanel(null);
      if (isMobile) setSidebarOpen(false);
      router.replace("/", { scroll: false });
    },
    [router, isMobile],
  );

  // Client-built transient SessionInfo (new session / fork) lacks the
  // server-computed projectRoot, which the same-project check in
  // handleCwdChange relies on. Hydrate it from the session list so switching
  // worktrees right after creating a session doesn't close the chat.
  const hydrateSelectedSession = useCallback((sessionId: string) => {
    void listSessions()
      .then((d) => {
        const full = d.sessions.find((s) => s.id === sessionId);
        if (!full) return;
        setSelectedSession((prev) => (prev && prev.id === sessionId && !prev.projectRoot ? full : prev));
      })
      .catch(() => {});
  }, []);

  // Called by ChatWindow when a new session gets its real id from pi
  const handleSessionCreated = useCallback(
    (session: SessionInfo) => {
      setNewSessionCwd(null);
      setSelectedSession(session);
      setRefreshKey((k) => k + 1);
      hydrateSelectedSession(session.id);
      router.replace(`?session=${encodeURIComponent(session.id)}`, { scroll: false });
    },
    [router, hydrateSelectedSession],
  );

  const handleAgentEnd = useCallback(() => {
    setRefreshKey((k) => k + 1);
    setExplorerRefreshKey((k) => k + 1);
  }, []);

  const handleSessionForked = useCallback(
    (newSessionId: string) => {
      setRefreshKey((k) => k + 1);
      setSessionKey((k) => k + 1);
      setNewSessionCwd(null);
      setSelectedSession((prev) => ({
        ...(prev ?? { path: "", cwd: "", created: "", modified: "", messageCount: 0, firstMessage: "" }),
        id: newSessionId,
      }));
      hydrateSelectedSession(newSessionId);
      router.replace(`?session=${encodeURIComponent(newSessionId)}`, { scroll: false });
    },
    [router, hydrateSelectedSession],
  );

  const handleInitialRestoreDone = useCallback(() => {
    setInitialSessionRestored(true);
  }, []);

  const handleSessionDeleted = useCallback(
    (sessionId: string) => {
      setRefreshKey((k) => k + 1);
      if (selectedSession?.id === sessionId) {
        const cwd = selectedSession.cwd;
        setSelectedSession(null);
        setNewSessionCwd(cwd ?? null);
        setSessionKey((k) => k + 1);
        setActiveTopPanel(null);
        router.replace("/", { scroll: false });
      }
    },
    [selectedSession, router],
  );

  const handleOpenFile = useCallback(
    (filePath: string, fileName: string, sourceSessionId?: string | null) => {
      const tabId = `file:${filePath}`;
      setFileTabs((prev) => {
        const existing = prev.find((t) => t.id === tabId);
        if (!existing) return [...prev, { id: tabId, label: fileName, filePath, sourceSessionId }];
        if (!sourceSessionId || existing.sourceSessionId === sourceSessionId) return prev;
        return prev.map((t) => (t.id === tabId ? { ...t, sourceSessionId } : t));
      });
      setActiveFileTabId(tabId);
      setRightPanelOpen(true);
      // On mobile the file panel is full-screen; close the drawer so it shows.
      if (isMobile) setSidebarOpen(false);
    },
    [isMobile],
  );

  const handleOpenLinkedFile = useCallback(
    (filePath: string) => {
      handleOpenFile(filePath, getFileName(filePath), selectedSession?.id ?? null);
    },
    [handleOpenFile, selectedSession?.id],
  );

  const handleCloseFileTab = useCallback(
    (tabId: string) => {
      setFileTabs((prev) => {
        const next = prev.filter((t) => t.id !== tabId);
        if (next.length === 0) setRightPanelOpen(false);
        return next;
      });
      setActiveFileTabId((cur) => {
        if (cur !== tabId) return cur;
        const remaining = fileTabs.filter((t) => t.id !== tabId);
        return remaining.length > 0 ? remaining[remaining.length - 1].id : EXPLORER_TAB_ID;
      });
    },
    [fileTabs],
  );

  // Show chat area if a session is selected, or if we have a cwd to start a new session in
  const effectiveNewSessionCwd = newSessionCwd ?? (selectedSession === null && activeCwd ? activeCwd : null);
  const showChat = selectedSession !== null || effectiveNewSessionCwd !== null;
  // While restoring initial session from URL, don't show the placeholder
  const showPlaceholder = initialSessionRestored && !showChat;

  const activeFileTab = fileTabs.find((t) => t.id === activeFileTabId) ?? null;
  const explorerCwd = activeCwd ?? selectedSession?.cwd ?? newSessionCwd;

  useEffect(() => {
    if (!activeCwd || isMobile) return;
    setRightPanelOpen(true);
    setActiveFileTabId(EXPLORER_TAB_ID);
  }, [activeCwd, isMobile]);

  const sidebarContent = (
    <>
      <SessionSidebar
        selectedSessionId={selectedSession?.id ?? null}
        onSelectSession={handleSelectSession}
        onNewSession={handleNewSession}
        initialSessionId={initialSessionId}
        onInitialRestoreDone={handleInitialRestoreDone}
        refreshKey={refreshKey}
        onSessionDeleted={handleSessionDeleted}
        selectedCwd={selectedSession?.cwd ?? newSessionCwd ?? null}
        onCwdChange={handleCwdChange}
      />
      <div style={{ padding: "8px", flexShrink: 0 }}>
        <button
          type="button"
          onClick={() => setSettingsOpen(true)}
          title={t("settings", "Settings")}
          style={{
            width: "100%",
            height: 34,
            padding: "0 12px",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            gap: 7,
            background: "none",
            border: "none",
            borderRadius: 9,
            color: "var(--text-muted)",
            cursor: "pointer",
            fontSize: 12,
            transition: "background 0.12s, color 0.12s",
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.background = "var(--bg-hover)";
            e.currentTarget.style.color = "var(--text)";
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.background = "none";
            e.currentTarget.style.color = "var(--text-muted)";
          }}
        >
          <svg
            width="15"
            height="15"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <circle cx="12" cy="12" r="3" />
            <path d="M19.4 15a1.7 1.7 0 0 0 .34 1.88l.06.06-2.83 2.83-.06-.06A1.7 1.7 0 0 0 15 19.4a1.7 1.7 0 0 0-1 .6 1.7 1.7 0 0 0-.4 1.1V21h-4v-.09A1.7 1.7 0 0 0 8.6 19.4a1.7 1.7 0 0 0-1.88.34l-.06.06-2.83-2.83.06-.06A1.7 1.7 0 0 0 4.6 15a1.7 1.7 0 0 0-.6-1 1.7 1.7 0 0 0-1.1-.4H3v-4h.09A1.7 1.7 0 0 0 4.6 8.6a1.7 1.7 0 0 0-.34-1.88l-.06-.06 2.83-2.83.06.06A1.7 1.7 0 0 0 9 4.6a1.7 1.7 0 0 0 1-.6 1.7 1.7 0 0 0 .4-1.1V3h4v.09A1.7 1.7 0 0 0 15.4 4.6a1.7 1.7 0 0 0 1.88-.34l.06-.06 2.83 2.83-.06.06A1.7 1.7 0 0 0 19.4 9c.12.38.33.72.6 1 .3.29.69.42 1.1.4h.09v4h-.09a1.7 1.7 0 0 0-1.7.6Z" />
          </svg>
          {t("settings", "Settings")}
        </button>
      </div>
    </>
  );

  return (
    <>
      <style>{`
      @keyframes session-info-pop {
        0% {
          opacity: 0;
          transform: translateY(-24px);
          filter: blur(6px);
          box-shadow: 0 2px 8px rgba(0,0,0,0);
        }
        55% {
          opacity: 1;
          transform: translateY(0);
          filter: blur(0);
          background: color-mix(in srgb, var(--accent) 8%, var(--bg-panel));
          box-shadow: 0 18px 44px color-mix(in srgb, var(--accent) 18%, transparent);
        }
        100% {
          opacity: 1;
          transform: translateY(0);
          filter: blur(0);
          background: var(--bg-panel);
          box-shadow: 0 10px 28px rgba(0,0,0,0.10);
        }
      }
      @keyframes session-info-light-wash {
        0% {
          opacity: 0;
          transform: translateX(-110%) skewX(-16deg);
        }
        24% {
          opacity: 0.42;
        }
        100% {
          opacity: 0;
          transform: translateX(115%) skewX(-16deg);
        }
      }
      .session-info-popover {
        position: relative;
        overflow: hidden;
        transform-origin: top right;
        animation: session-info-pop 360ms ease-out both;
        will-change: transform, opacity, filter, background, box-shadow;
      }
      .session-info-popover::after {
        content: "";
        position: absolute;
        top: 0;
        bottom: 0;
        left: 0;
        width: 44%;
        pointer-events: none;
        background: linear-gradient(90deg, transparent, color-mix(in srgb, var(--accent) 24%, transparent), transparent);
        animation: session-info-light-wash 620ms ease-out both;
      }
      @media (prefers-reduced-motion: reduce) {
        .session-info-popover,
        .session-info-popover::after {
          animation: none;
        }
      }
      @media (max-width: 640px) {
        .sidebar-overlay-backdrop.sidebar-mobile-pending {
          opacity: 0 !important;
          pointer-events: none !important;
        }
        .sidebar-container.sidebar-mobile-pending.sidebar-open {
          transform: translateX(-100%);
          box-shadow: none;
        }
      }
    `}</style>
      <div style={{ display: "flex", height: "100dvh", overflow: "hidden", background: "var(--bg)" }}>
        {/* Mobile overlay backdrop */}
        <div
          className={`sidebar-overlay-backdrop${mobileSidebarReady ? "" : " sidebar-mobile-pending"}`}
          onClick={() => setSidebarOpen(false)}
          style={{
            position: "fixed",
            inset: 0,
            zIndex: 199,
            background: "rgba(0,0,0,0.4)",
            opacity: sidebarOpen ? 1 : 0,
            pointerEvents: sidebarOpen ? "auto" : "none",
            transition: "opacity 0.25s ease",
          }}
        />

        {/* Left sidebar */}
        <div
          className={`sidebar-container${sidebarOpen ? " sidebar-open" : " sidebar-closed"}${mobileSidebarReady ? "" : " sidebar-mobile-pending"}`}
          style={{
            background: "var(--bg-panel)",
            borderRight: "1px solid var(--border)",
            display: "flex",
            flexDirection: "column",
            flexShrink: 0,
            zIndex: 200,
          }}
        >
          {sidebarContent}
        </div>

        {/* Center: chat */}
        <div
          style={{
            flex: 1,
            display: "flex",
            flexDirection: "column",
            overflow: "hidden",
            minWidth: 0,
            position: "relative",
          }}
        >
          {/* Top bar with sidebar toggle */}
          <div
            style={{
              display: "flex",
              alignItems: "center",
              flexShrink: 0,
              borderBottom: "1px solid var(--border)",
              height: 44,
              background: "var(--bg-panel)",
              position: "relative",
              zIndex: 2,
            }}
          >
            <button
              onClick={handleSidebarToggle}
              title={sidebarOpen ? t("hideSidebar", "Hide sidebar") : t("showSidebar", "Show sidebar")}
              aria-label={sidebarOpen ? t("hideSidebar", "Hide sidebar") : t("showSidebar", "Show sidebar")}
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                width: 36,
                height: 36,
                padding: 0,
                background: "none",
                border: "none",
                borderRight: "1px solid var(--border)",
                color: "var(--text-muted)",
                cursor: "pointer",
                flexShrink: 0,
                transition: "color 0.12s",
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.color = "var(--text)";
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.color = "var(--text-muted)";
              }}
            >
              {sidebarOpen ? (
                <svg
                  width="16"
                  height="16"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <rect x="3" y="3" width="18" height="18" rx="2" />
                  <line x1="9" y1="3" x2="9" y2="21" />
                </svg>
              ) : (
                <svg
                  width="18"
                  height="18"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                >
                  <line x1="3" y1="6" x2="21" y2="6" />
                  <line x1="3" y1="12" x2="21" y2="12" />
                  <line x1="3" y1="18" x2="21" y2="18" />
                </svg>
              )}
            </button>
            <button
              onClick={(e) => {
                const rect = e.currentTarget.getBoundingClientRect();
                toggleTheme({ x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 });
              }}
              title={isDark ? t("switchToLight", "Switch to light mode") : t("switchToDark", "Switch to dark mode")}
              aria-label={
                isDark ? t("switchToLight", "Switch to light mode") : t("switchToDark", "Switch to dark mode")
              }
              aria-pressed={isDark}
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                width: 36,
                height: 36,
                padding: 0,
                background: "none",
                border: "none",
                borderRight: "1px solid var(--border)",
                color: "var(--text-muted)",
                cursor: "pointer",
                flexShrink: 0,
                transition: "color 0.12s",
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.color = "var(--text)";
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.color = "var(--text-muted)";
              }}
            >
              {isDark ? (
                <svg
                  width="16"
                  height="16"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <circle cx="12" cy="12" r="5" />
                  <line x1="12" y1="1" x2="12" y2="3" />
                  <line x1="12" y1="21" x2="12" y2="23" />
                  <line x1="4.22" y1="4.22" x2="5.64" y2="5.64" />
                  <line x1="18.36" y1="18.36" x2="19.78" y2="19.78" />
                  <line x1="1" y1="12" x2="3" y2="12" />
                  <line x1="21" y1="12" x2="23" y2="12" />
                  <line x1="4.22" y1="19.78" x2="5.64" y2="18.36" />
                  <line x1="18.36" y1="5.64" x2="19.78" y2="4.22" />
                </svg>
              ) : (
                <svg
                  width="16"
                  height="16"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
                </svg>
              )}
            </button>
            {/* Session stats — right-aligned in top bar */}
            {showChat &&
              (sessionStats || contextUsage) &&
              (() => {
                const tokenStats = sessionStats?.tokens;
                const c = sessionStats?.cost ?? 0;
                const fmt = (n: number) =>
                  n >= 1_000_000
                    ? `${(n / 1_000_000).toFixed(1)}M`
                    : n >= 1000
                      ? `${(n / 1000).toFixed(0)}k`
                      : String(n);
                const costStr = c > 0 ? (c >= 0.01 ? `$${c.toFixed(2)}` : `<$0.01`) : null;

                let ctxColor = "var(--text-muted)";
                let ctxStr: string | null = null;
                if (contextUsage?.contextWindow) {
                  const pct = contextUsage.percent;
                  if (pct !== null && pct > 90) ctxColor = "#ef4444";
                  else if (pct !== null && pct > 70) ctxColor = "rgba(234,179,8,0.95)";
                  ctxStr =
                    pct !== null
                      ? `${pct.toFixed(0)}% / ${fmt(contextUsage.contextWindow)}`
                      : `? / ${fmt(contextUsage.contextWindow)}`;
                }

                const tooltipParts: string[] = [];
                if (tokenStats) {
                  tooltipParts.push(`${t("usageInput", "Input")}: ${tokenStats.input.toLocaleString(language)}`);
                  tooltipParts.push(`${t("usageOutput", "Output")}: ${tokenStats.output.toLocaleString(language)}`);
                  tooltipParts.push(
                    `${t("cacheRead", "Cache read")}: ${tokenStats.cacheRead.toLocaleString(language)}`,
                  );
                  tooltipParts.push(
                    `${t("cacheWrite", "Cache write")}: ${tokenStats.cacheWrite.toLocaleString(language)}`,
                  );
                  if (c > 0) tooltipParts.push(`${t("usageCost", "Cost")}: $${c.toFixed(4)}`);
                }
                if (contextUsage?.contextWindow) {
                  const pct = contextUsage.percent;
                  tooltipParts.push(
                    `${t("usageContext", "Context")}: ${pct !== null ? pct.toFixed(1) + "%" : t("unknown", "unknown")} / ${contextUsage.contextWindow.toLocaleString(language)} ${t("tokens", "tokens")}`,
                  );
                }
                const tooltip = tooltipParts.join("  |  ");

                return (
                  <button
                    type="button"
                    onClick={toggleTopPanel}
                    title={tooltip || t("sessionInfo", "Session info")}
                    aria-label={t("sessionInfo", "Session info")}
                    aria-pressed={activeTopPanel === "session"}
                    style={{
                      marginLeft: "auto",
                      display: "flex",
                      alignItems: "center",
                      gap: 10,
                      paddingLeft: 12,
                      paddingRight: rightPanelOpen ? 12 : 48,
                      height: "100%",
                      background: activeTopPanel === "session" ? "var(--bg-selected)" : "none",
                      border: "none",
                      borderTop: activeTopPanel === "session" ? "2px solid var(--accent)" : "2px solid transparent",
                      fontSize: 11,
                      color: "var(--text-muted)",
                      whiteSpace: "nowrap",
                      cursor: "pointer",
                      fontVariantNumeric: "tabular-nums",
                      transition: "color 0.1s, background 0.1s",
                    }}
                    onMouseEnter={(e) => {
                      e.currentTarget.style.color = "var(--text)";
                    }}
                    onMouseLeave={(e) => {
                      e.currentTarget.style.color = activeTopPanel === "session" ? "var(--text)" : "var(--text-muted)";
                    }}
                  >
                    {isMobile && (
                      <svg
                        width="14"
                        height="14"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        aria-hidden="true"
                      >
                        <circle cx="12" cy="12" r="10" />
                        <line x1="12" y1="16" x2="12" y2="12" />
                        <line x1="12" y1="8" x2="12.01" y2="8" />
                      </svg>
                    )}
                    {!isMobile && tokenStats && tokenStats.input > 0 && (
                      <span style={{ display: "flex", alignItems: "center", gap: 4 }}>
                        <svg
                          width="12"
                          height="12"
                          viewBox="0 0 10 10"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="1.2"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                        >
                          <line x1="5" y1="8.5" x2="5" y2="1.5" />
                          <polyline points="2 4 5 1.5 8 4" />
                        </svg>
                        {fmt(tokenStats.input)}
                      </span>
                    )}
                    {!isMobile && tokenStats && tokenStats.output > 0 && (
                      <span style={{ display: "flex", alignItems: "center", gap: 4 }}>
                        <svg
                          width="12"
                          height="12"
                          viewBox="0 0 10 10"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="1.2"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                        >
                          <line x1="5" y1="1.5" x2="5" y2="8.5" />
                          <polyline points="2 6 5 8.5 8 6" />
                        </svg>
                        {fmt(tokenStats.output)}
                      </span>
                    )}
                    {!isMobile && tokenStats && tokenStats.cacheRead > 0 && (
                      <span style={{ display: "flex", alignItems: "center", gap: 4 }}>
                        <svg
                          width="12"
                          height="12"
                          viewBox="0 0 10 10"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="1.2"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                        >
                          <path d="M8.5 5a3.5 3.5 0 1 1-1-2.45" />
                          <polyline points="6.5 1.5 8.5 2.5 7.5 4.5" />
                        </svg>
                        {fmt(tokenStats.cacheRead)}
                      </span>
                    )}
                    {!isMobile && costStr && (
                      <span style={{ display: "flex", alignItems: "center", color: "var(--text)", fontWeight: 500 }}>
                        {costStr}
                      </span>
                    )}
                    {ctxStr && (
                      <span style={{ display: "flex", alignItems: "center", gap: 4, color: ctxColor }}>
                        <svg
                          width="12"
                          height="12"
                          viewBox="0 0 10 10"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="1.2"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                        >
                          <path d="M1 9 L1 5 Q1 1 5 1 Q9 1 9 5 L9 9" />
                          <line x1="1" y1="9" x2="9" y2="9" />
                        </svg>
                        {ctxStr}
                      </span>
                    )}
                  </button>
                );
              })()}
            {/* Top panel dropdown — shared, only one active at a time */}
            {activeTopPanel && (
              <div
                style={{
                  position: "absolute",
                  top: "100%",
                  left: 0,
                  right: 0,
                  maxHeight: "calc(100dvh - 44px)",
                  overflowY: "auto",
                  zIndex: 50,
                }}
              >
                {activeTopPanel === "session" && (
                  <div
                    className="session-info-popover"
                    style={{
                      background: "var(--bg-panel)",
                      borderBottom: "1px solid var(--border)",
                      boxShadow: "0 10px 28px rgba(0,0,0,0.10)",
                      padding: "12px 16px",
                    }}
                  >
                    {sessionStats ? (
                      (() => {
                        const sessionRows = [
                          ...(sessionStats.sessionName
                            ? [{ label: t("sessionName", "Name"), value: sessionStats.sessionName, copyField: null }]
                            : []),
                          {
                            label: t("sessionFile", "File"),
                            value: sessionStats.sessionFile ?? t("inMemory", "In-memory"),
                            copyField: "file" as const,
                          },
                          { label: t("sessionId", "ID"), value: sessionStats.sessionId, copyField: "id" as const },
                        ];
                        const messageRows = [
                          [t("user", "User"), sessionStats.userMessages.toLocaleString(language)],
                          [t("assistant", "Assistant"), sessionStats.assistantMessages.toLocaleString(language)],
                          [t("toolCalls", "Tool Calls"), sessionStats.toolCalls.toLocaleString(language)],
                          [t("toolResults", "Tool Results"), sessionStats.toolResults.toLocaleString(language)],
                          [t("total", "Total"), sessionStats.totalMessages.toLocaleString(language)],
                        ];
                        const tokenRows = [
                          [t("usageInput", "Input"), sessionStats.tokens.input.toLocaleString(language)],
                          [t("usageOutput", "Output"), sessionStats.tokens.output.toLocaleString(language)],
                          ...(sessionStats.tokens.cacheRead > 0
                            ? [[t("cacheRead", "Cache Read"), sessionStats.tokens.cacheRead.toLocaleString(language)]]
                            : []),
                          ...(sessionStats.tokens.cacheWrite > 0
                            ? [
                                [
                                  t("cacheWrite", "Cache Write"),
                                  sessionStats.tokens.cacheWrite.toLocaleString(language),
                                ],
                              ]
                            : []),
                          [t("total", "Total"), sessionStats.tokens.total.toLocaleString(language)],
                        ];
                        const ctx = contextUsage ?? sessionStats.contextUsage;
                        const formatCompact = (n: number) =>
                          n >= 1_000_000
                            ? `${(n / 1_000_000).toFixed(1)}M`
                            : n >= 1000
                              ? `${(n / 1000).toFixed(0)}k`
                              : String(n);
                        const extraTokenRows = [
                          ...(sessionStats.cost > 0
                            ? [[t("usageCost", "Cost"), `$${sessionStats.cost.toFixed(4)}`]]
                            : []),
                          ...(ctx?.contextWindow
                            ? [
                                [
                                  t("usageContext", "Context"),
                                  `${ctx.percent !== null ? `${ctx.percent.toFixed(1)}%` : "?"} / ${formatCompact(ctx.contextWindow)}`,
                                ],
                              ]
                            : []),
                        ];
                        const section = (
                          title: string,
                          sectionRows: string[][],
                          valueAlign: "left" | "right" = "left",
                          compact = false,
                        ) => (
                          <div style={{ minWidth: 0 }}>
                            <div style={{ fontSize: 11, fontWeight: 700, color: "var(--text)", marginBottom: 6 }}>
                              {title}
                            </div>
                            <div
                              style={{
                                display: "grid",
                                gridTemplateColumns: compact ? "max-content max-content" : "auto minmax(0, 1fr)",
                                columnGap: compact ? 14 : 12,
                                rowGap: 4,
                                justifyContent: compact ? "start" : undefined,
                              }}
                            >
                              {sectionRows.map(([label, value]) => (
                                <div key={`${title}:${label}`} style={{ display: "contents" }}>
                                  <div style={{ color: "var(--text-dim)", whiteSpace: "nowrap" }}>{label}</div>
                                  <div
                                    style={{
                                      color: "var(--text-muted)",
                                      minWidth: 0,
                                      overflowWrap: compact ? "normal" : "anywhere",
                                      textAlign: valueAlign,
                                      whiteSpace: valueAlign === "right" ? "nowrap" : "normal",
                                    }}
                                  >
                                    {value}
                                  </div>
                                </div>
                              ))}
                            </div>
                          </div>
                        );
                        const copyButton = (field: SessionCopyField, value: string) => {
                          const copied = copiedSessionField === field;
                          return (
                            <button
                              type="button"
                              title={
                                copied
                                  ? t("copied", "Copied")
                                  : field === "file"
                                    ? t("copyFilePath", "Copy file path")
                                    : t("copySessionId", "Copy session ID")
                              }
                              onClick={() => handleCopySessionField(field, value)}
                              style={{
                                alignSelf: "start",
                                display: "inline-flex",
                                alignItems: "center",
                                justifyContent: "center",
                                width: 22,
                                height: 22,
                                marginTop: -2,
                                color: copied ? "var(--accent)" : "var(--text-dim)",
                                background: "transparent",
                                border: "1px solid var(--border)",
                                borderRadius: 4,
                                cursor: "pointer",
                                flex: "0 0 auto",
                                transition: "color 0.12s, border-color 0.12s, background 0.12s",
                              }}
                              onMouseEnter={(e) => {
                                e.currentTarget.style.color = "var(--accent)";
                                e.currentTarget.style.borderColor = "var(--accent)";
                                e.currentTarget.style.background = "var(--bg-hover)";
                              }}
                              onMouseLeave={(e) => {
                                e.currentTarget.style.color = copied ? "var(--accent)" : "var(--text-dim)";
                                e.currentTarget.style.borderColor = "var(--border)";
                                e.currentTarget.style.background = "transparent";
                              }}
                            >
                              {copied ? (
                                <svg
                                  width="12"
                                  height="12"
                                  viewBox="0 0 24 24"
                                  fill="none"
                                  stroke="currentColor"
                                  strokeWidth="2"
                                  strokeLinecap="round"
                                  strokeLinejoin="round"
                                  aria-hidden="true"
                                >
                                  <polyline points="20 6 9 17 4 12" />
                                </svg>
                              ) : (
                                <svg
                                  width="12"
                                  height="12"
                                  viewBox="0 0 24 24"
                                  fill="none"
                                  stroke="currentColor"
                                  strokeWidth="2"
                                  strokeLinecap="round"
                                  strokeLinejoin="round"
                                  aria-hidden="true"
                                >
                                  <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
                                  <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
                                </svg>
                              )}
                            </button>
                          );
                        };
                        const sessionInfoSection = (
                          <div style={{ minWidth: 0 }}>
                            <div style={{ fontSize: 11, fontWeight: 700, color: "var(--text)", marginBottom: 6 }}>
                              {t("sessionInfo", "Session Info")}
                            </div>
                            <div
                              style={{
                                display: "grid",
                                gridTemplateColumns: "auto minmax(0, 1fr) auto",
                                columnGap: 12,
                                rowGap: 8,
                                alignItems: "start",
                              }}
                            >
                              {sessionRows.map((row) => (
                                <div key={`session-info:${row.label}`} style={{ display: "contents" }}>
                                  <div style={{ color: "var(--text-dim)", whiteSpace: "nowrap" }}>{row.label}</div>
                                  <div
                                    style={{
                                      color: "var(--text-muted)",
                                      minWidth: 0,
                                      overflowWrap: "anywhere",
                                      wordBreak: "break-word",
                                      whiteSpace: "normal",
                                    }}
                                  >
                                    {row.value}
                                  </div>
                                  <div>{row.copyField ? copyButton(row.copyField, row.value) : null}</div>
                                </div>
                              ))}
                            </div>
                          </div>
                        );

                        return (
                          <div
                            style={{
                              display: "grid",
                              gridTemplateColumns: isMobile
                                ? "1fr"
                                : "minmax(360px, 1.7fr) minmax(140px, 0.55fr) minmax(190px, 0.75fr)",
                              gap: isMobile ? 16 : 24,
                              fontSize: 12,
                              lineHeight: 1.5,
                              fontFamily: "var(--font-mono)",
                            }}
                          >
                            {sessionInfoSection}
                            {section(t("messages", "Messages"), messageRows)}
                            {section(t("tokens", "Tokens"), [...tokenRows, ...extraTokenRows], "right", true)}
                          </div>
                        );
                      })()
                    ) : (
                      <div style={{ fontSize: 12, color: "var(--text-muted)", fontStyle: "italic" }}>
                        {t("loadSessionInfoHint", "Send a message or run /session to load session info")}
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Chat content */}
          <div style={{ flex: 1, overflow: "hidden", position: "relative" }}>
            {showChat ? (
              <ChatWindow
                key={sessionKey}
                session={selectedSession}
                newSessionCwd={effectiveNewSessionCwd}
                onAgentEnd={handleAgentEnd}
                onSessionCreated={handleSessionCreated}
                onSessionForked={handleSessionForked}
                modelsRefreshKey={modelsRefreshKey}
                chatInputRef={chatInputRef}
                onSessionStatsChange={handleSessionStatsChange}
                onSessionStatsPanelOpen={openSessionStatsPanel}
                onContextUsageChange={handleContextUsageChange}
                onOpenFile={handleOpenLinkedFile}
              />
            ) : showPlaceholder ? (
              activeCwd ? (
                <div
                  style={{
                    height: "100%",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    color: "var(--text-muted)",
                    fontSize: 15,
                  }}
                >
                  {t("selectSession", "Select a session from the sidebar")}
                </div>
              ) : (
                <div
                  style={{
                    position: "absolute",
                    top: 12,
                    left: 12,
                    display: "flex",
                    alignItems: "flex-start",
                    gap: 8,
                    userSelect: "none",
                    pointerEvents: "none",
                  }}
                >
                  <svg
                    width="44"
                    height="44"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="var(--accent)"
                    strokeWidth="1.5"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    style={{ opacity: 0.7, flexShrink: 0 }}
                  >
                    <line x1="20" y1="12" x2="4" y2="12" />
                    <polyline points="10 6 4 12 10 18" />
                  </svg>
                  <div>
                    <div style={{ fontSize: 18, fontWeight: 600, color: "var(--text)", marginBottom: 8 }}>
                      {t("getStarted", "Get Started")}
                    </div>
                    <div style={{ fontSize: 12, color: "var(--text-muted)", lineHeight: 1.8 }}>
                      <span style={{ color: "var(--text-dim)", marginRight: 6 }}>1.</span>
                      {t("selectProject", "Select a project directory from the sidebar")}
                      <br />
                      <span style={{ color: "var(--text-dim)", marginRight: 6 }}>2.</span>
                      {t("addModelsFromSettings", "Open Settings at the bottom, then add models")}
                    </div>
                  </div>
                </div>
              )
            ) : null}
          </div>
        </div>

        {/* Right panel: explorer and file previews — always mounted, width animated via CSS */}
        <div
          className={`right-panel-container${rightPanelOpen ? " right-panel-open" : " right-panel-closed"}${rightPanelResizing ? " right-panel-resizing" : ""}`}
          style={
            {
              display: "flex",
              flexDirection: "column",
              borderLeft: "1px solid var(--border)",
              background: "var(--bg)",
              "--right-panel-width": `${rightPanelWidth}px`,
            } as CSSProperties
          }
        >
          <div
            className="right-panel-resizer"
            role="separator"
            aria-label={t("resizeRightPanel", "Resize right panel")}
            aria-orientation="vertical"
            aria-valuemin={280}
            aria-valuenow={Math.round(rightPanelWidth)}
            onPointerDown={handleRightPanelResizeStart}
          />
          {/* Right panel tab bar */}
          <div
            style={{
              display: "flex",
              alignItems: "center",
              flexShrink: 0,
              background: "var(--bg-panel)",
              borderBottom: "1px solid var(--border)",
              height: 36,
              paddingRight: 36,
              boxSizing: "border-box",
            }}
          >
            <button
              type="button"
              onClick={() => setActiveFileTabId(EXPLORER_TAB_ID)}
              aria-pressed={activeFileTabId === EXPLORER_TAB_ID}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 6,
                height: 36,
                padding: "0 12px",
                flexShrink: 0,
                background: activeFileTabId === EXPLORER_TAB_ID ? "var(--bg)" : "var(--bg-panel)",
                border: "none",
                borderRight: "1px solid var(--border)",
                color: activeFileTabId === EXPLORER_TAB_ID ? "var(--text)" : "var(--text-muted)",
                cursor: "pointer",
                fontSize: 12,
                fontWeight: activeFileTabId === EXPLORER_TAB_ID ? 500 : 400,
              }}
            >
              <svg
                width="13"
                height="13"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <path d="M3 5a2 2 0 0 1 2-2h5l2 2h7a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z" />
              </svg>
              Explorer
            </button>
            <div style={{ flex: 1, overflow: "hidden" }}>
              <TabBar
                tabs={fileTabs}
                activeTabId={activeFileTabId ?? ""}
                onSelectTab={setActiveFileTabId}
                onCloseTab={handleCloseFileTab}
              />
            </div>
            {activeFileTabId === EXPLORER_TAB_ID && explorerCwd && (
              <button
                type="button"
                onClick={() => setExplorerRefreshKey((key) => key + 1)}
                title={t("refreshExplorer", "Refresh explorer")}
                aria-label={t("refreshExplorer", "Refresh explorer")}
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  width: 34,
                  height: 34,
                  padding: 0,
                  marginRight: 2,
                  flexShrink: 0,
                  background: "none",
                  border: "none",
                  color: "var(--text-dim)",
                  cursor: "pointer",
                  borderRadius: 5,
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.color = "var(--text)";
                  e.currentTarget.style.background = "var(--bg-hover)";
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.color = "var(--text-dim)";
                  e.currentTarget.style.background = "none";
                }}
              >
                <svg
                  width="13"
                  height="13"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden="true"
                >
                  <path d="M3 12a9 9 0 1 0 3-6.7L3 8" />
                  <path d="M3 3v5h5" />
                </svg>
              </button>
            )}
          </div>

          {/* Explorer or file content */}
          <div style={{ flex: 1, overflow: "hidden" }}>
            {activeFileTabId === EXPLORER_TAB_ID ? (
              explorerCwd ? (
                <div style={{ height: "100%", overflowY: "auto", overflowX: "hidden", paddingTop: 4 }}>
                  <FileExplorer
                    cwd={explorerCwd}
                    onOpenFile={handleOpenFile}
                    refreshKey={explorerRefreshKey}
                    onAtMention={handleAtMention}
                  />
                </div>
              ) : (
                <div
                  style={{
                    height: "100%",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    color: "var(--text-dim)",
                    fontSize: 12,
                  }}
                >
                  Select a project to browse files
                </div>
              )
            ) : activeFileTab?.filePath ? (
              <FileViewer
                key={activeFileTab.id ?? activeFileTab.filePath}
                filePath={activeFileTab.filePath}
                cwd={activeCwd ?? undefined}
                sourceSessionId={activeFileTab.sourceSessionId}
              />
            ) : (
              <div
                style={{
                  height: "100%",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  color: "var(--text-dim)",
                  fontSize: 12,
                }}
              >
                Select Explorer or open a file
              </div>
            )}
          </div>
        </div>
      </div>
      {/* File panel toggle — always visible at top-right */}
      <button
        onClick={() => setRightPanelOpen((v) => !v)}
        title={rightPanelOpen ? t("hideFilePanel", "Hide file panel") : t("showFilePanel", "Show file panel")}
        aria-label={rightPanelOpen ? t("hideFilePanel", "Hide file panel") : t("showFilePanel", "Show file panel")}
        style={{
          position: "fixed",
          top: 0,
          right: 0,
          zIndex: 300,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          width: 36,
          height: 36,
          padding: 0,
          background: "var(--bg-panel)",
          border: "none",
          borderLeft: "1px solid var(--border)",
          borderBottom: "1px solid var(--border)",
          color: rightPanelOpen ? "var(--text)" : "var(--text-muted)",
          cursor: "pointer",
          transition: "color 0.12s",
        }}
        onMouseEnter={(e) => {
          e.currentTarget.style.color = "var(--text)";
        }}
        onMouseLeave={(e) => {
          e.currentTarget.style.color = rightPanelOpen ? "var(--text)" : "var(--text-muted)";
        }}
      >
        <svg
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <rect x="3" y="3" width="18" height="18" rx="2" />
          <line x1="15" y1="3" x2="15" y2="21" />
        </svg>
      </button>
      {settingsOpen && (
        <SettingsConfig
          cwd={activeCwd ?? selectedSession?.cwd ?? newSessionCwd ?? null}
          sessionId={selectedSession?.id ?? null}
          onClose={() => setSettingsOpen(false)}
          onModelsChanged={() => setModelsRefreshKey((key) => key + 1)}
          onPluginsReloaded={() => setSessionKey((key) => key + 1)}
        />
      )}
    </>
  );
}
