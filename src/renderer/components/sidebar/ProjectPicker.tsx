import { useState, useRef, useCallback, useEffect } from "react";
import { call } from "@/lib/api-client";
import { useI18n } from "@/i18n";
import type { SessionInfo } from "@/lib/types";
import { getRecentProjects } from "@/hooks/useSidebarWorkspace";
import { abbreviateHomePath } from "@/lib/display-path";
import { PathLabel, AnimatedDropdown, useDeferredFocus } from "./WorkspaceDropdown";

interface Props {
  selectedCwd: string | null;
  selectedProject: string | null;
  homeDir: string;
  allSessions: SessionInfo[];
  restoringInitialSession: boolean;
  setSelectedCwd: (cwd: string | null) => void;
}

export function ProjectPicker({
  selectedCwd,
  selectedProject,
  homeDir,
  allSessions,
  restoringInitialSession,
  setSelectedCwd,
}: Props) {
  const { t } = useI18n();
  const deferFocus = useDeferredFocus();
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const [projectFilter, setProjectFilter] = useState("");
  const [customPathOpen, setCustomPathOpen] = useState(false);
  const [customPathValue, setCustomPathValue] = useState("");
  const [customPathError, setCustomPathError] = useState<string | null>(null);
  const [customPathValidating, setCustomPathValidating] = useState(false);
  const customPathInputRef = useRef<HTMLInputElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const commitCustomPath = useCallback(async () => {
    const path = customPathValue.trim();
    if (!path || customPathValidating) return;

    setCustomPathValidating(true);
    setCustomPathError(null);
    try {
      const result = await call("system.validateCwd", { path: path });
      if (!result.ok) {
        setCustomPathError(result.error ?? t("invalidDirectory", "Invalid directory"));
        return;
      }
      setSelectedCwd(result.path ?? path);
      setCustomPathOpen(false);
      setCustomPathValue("");
      setDropdownOpen(false);
    } catch (e) {
      setCustomPathError(e instanceof Error ? e.message : String(e));
    } finally {
      setCustomPathValidating(false);
    }
  }, [customPathValue, customPathValidating, setSelectedCwd, t]);

  const handleDefaultCwd = useCallback(async () => {
    try {
      const data = await call("system.defaultCwd");
      if (data.cwd) {
        setSelectedCwd(data.cwd);
        setCustomPathOpen(false);
        setCustomPathValue("");
        setCustomPathError(null);
        setDropdownOpen(false);
      }
    } catch {
      // ignore
    }
  }, [setSelectedCwd]);

  /** Desktop-native directory picker (design §6.1). Falls back to path input. */
  const handlePickDirectory = useCallback(async () => {
    try {
      const dir = await window.piBridge?.selectDirectory?.();
      if (!dir) return;
      const result = await call("system.validateCwd", { path: dir });
      if (!result.ok) {
        setCustomPathError(result.error ?? t("invalidDirectory", "Invalid directory"));
        return;
      }
      setSelectedCwd(result.path ?? dir);
      setCustomPathOpen(false);
      setCustomPathValue("");
      setCustomPathError(null);
      setDropdownOpen(false);
    } catch (e) {
      setCustomPathError(e instanceof Error ? e.message : String(e));
    }
  }, [setSelectedCwd, t]);

  // Close dropdowns on outside click
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setDropdownOpen(false);
        setProjectFilter("");
        setCustomPathOpen(false);
        setCustomPathValue("");
        setCustomPathError(null);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  const recentProjects = getRecentProjects(allSessions);
  const showProjectFilter = recentProjects.length > 8;
  const visibleProjects = projectFilter.trim()
    ? recentProjects.filter((p) => p.toLowerCase().includes(projectFilter.trim().toLowerCase()))
    : recentProjects;

  return (
    <div ref={dropdownRef} style={{ position: "relative" }}>
      <button
        onClick={() => setDropdownOpen((v) => !v)}
        title={selectedProject ?? selectedCwd ?? ""}
        style={{
          width: "100%",
          display: "flex",
          alignItems: "center",
          padding: "6px 10px",
          background: selectedCwd ? "var(--bg-hover)" : "var(--accent-soft)",
          border: selectedCwd ? "1px solid var(--border)" : "1px solid var(--accent-soft-border)",
          borderRadius: 7,
          cursor: "pointer",
          fontSize: 12,
          color: "var(--text)",
          textAlign: "left",
          transition: "border-color 0.15s, background 0.15s",
        }}
      >
        {selectedCwd ? (
          <PathLabel
            text={abbreviateHomePath(selectedProject ?? selectedCwd, homeDir)}
            style={{
              flex: 1,
              fontFamily: "var(--font-mono)",
              fontSize: 11,
              color: "var(--text)",
            }}
          />
        ) : (
          <span
            style={{
              flex: 1,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
              fontFamily: "var(--font-mono)",
              fontSize: 11,
              color: "var(--text-dim)",
            }}
          >
            {restoringInitialSession ? "" : t("selectProjectEllipsis", "Select project…")}
          </span>
        )}
      </button>

      <AnimatedDropdown
        open={dropdownOpen}
        style={{
          position: "absolute",
          top: "calc(100% + 4px)",
          left: 0,
          right: 0,
          zIndex: 100,
          background: "var(--bg)",
          border: "1px solid var(--border)",
          borderRadius: 8,
          boxShadow: "0 6px 20px rgba(0,0,0,0.10)",
          overflow: "hidden",
        }}
      >
        {showProjectFilter && (
          <div style={{ padding: "6px 8px", borderBottom: "1px solid var(--border)" }}>
            <input
              value={projectFilter}
              onChange={(e) => setProjectFilter(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Escape") {
                  setProjectFilter("");
                  setDropdownOpen(false);
                }
              }}
              placeholder={t("filterProjects", "Filter projects…")}
              autoFocus
              style={{
                width: "100%",
                fontSize: 11,
                fontFamily: "var(--font-mono)",
                padding: "5px 8px",
                border: "1px solid var(--border)",
                borderRadius: 5,
                outline: "none",
                background: "var(--bg)",
                color: "var(--text)",
                boxSizing: "border-box",
              }}
            />
          </div>
        )}
        <div style={{ maxHeight: "min(50vh, 380px)", overflowY: "auto" }}>
          {visibleProjects.map((project) => (
            <button
              key={project}
              onClick={() => {
                setSelectedCwd(project);
                setProjectFilter("");
                setCustomPathOpen(false);
                setCustomPathValue("");
                setCustomPathError(null);
                setDropdownOpen(false);
              }}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 7,
                width: "100%",
                padding: "8px 10px",
                background: "var(--bg)",
                border: "none",
                borderBottom: "1px solid var(--border)",
                color: project === selectedProject ? "var(--text)" : "var(--text-muted)",
                cursor: "pointer",
                textAlign: "left",
                fontSize: 11,
                fontFamily: "var(--font-mono)",
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
              title={project}
            >
              {project === selectedProject && (
                <svg
                  width="10"
                  height="10"
                  viewBox="0 0 10 10"
                  fill="none"
                  stroke="var(--accent)"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  style={{ flexShrink: 0 }}
                >
                  <polyline points="1.5 5 4 7.5 8.5 2.5" />
                </svg>
              )}
              {project !== selectedProject && <span style={{ width: 10, flexShrink: 0 }} />}
              <PathLabel text={abbreviateHomePath(project, homeDir)} style={{ flex: 1 }} />
            </button>
          ))}
          {visibleProjects.length === 0 && projectFilter.trim() && (
            <div style={{ padding: "8px 10px", fontSize: 11, color: "var(--text-dim)" }}>
              {t("noMatchingProjects", "No matching projects")}
            </div>
          )}
        </div>

        {/* Default cwd shortcut */}
        {!customPathOpen && (
          <button
            onClick={(e) => {
              e.stopPropagation();
              void handleDefaultCwd();
            }}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 7,
              width: "100%",
              padding: "8px 10px",
              background: "none",
              border: "none",
              borderTop: visibleProjects.length > 0 ? "1px solid var(--border)" : "none",
              color: "var(--text-muted)",
              cursor: "pointer",
              textAlign: "left",
              fontSize: 11,
            }}
          >
            <svg
              width="10"
              height="10"
              viewBox="0 0 10 10"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.1"
              strokeLinecap="round"
              strokeLinejoin="round"
              style={{ flexShrink: 0 }}
            >
              <path d="M1 3A1 1 0 0 1 2 2H4L5 3.5H8.5a.5.5 0 0 1 .5.5v4a.5.5 0 0 1-.5.5h-7A.5.5 0 0 1 1 8V3Z" />
            </svg>
            <span>{t("useDefaultDirectory", "Use default directory")}</span>
          </button>
        )}

        {/* Native directory picker (desktop) */}
        {!customPathOpen && typeof window !== "undefined" && !!window.piBridge && (
          <button
            onClick={(e) => {
              e.stopPropagation();
              void handlePickDirectory();
            }}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 7,
              width: "100%",
              padding: "8px 10px",
              background: "none",
              border: "none",
              color: "var(--text-muted)",
              cursor: "pointer",
              textAlign: "left",
              fontSize: 11,
            }}
          >
            <svg
              width="10"
              height="10"
              viewBox="0 0 10 10"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.1"
              strokeLinecap="round"
              strokeLinejoin="round"
              style={{ flexShrink: 0 }}
            >
              <path d="M1 3A1 1 0 0 1 2 2H4L5 3.5H8.5a.5.5 0 0 1 .5.5v4a.5.5 0 0 1-.5.5h-7A.5.5 0 0 1 1 8V3Z" />
            </svg>
            <span>{t("browseFolder", "Browse folder…")}</span>
          </button>
        )}

        {/* Custom path entry */}
        {!customPathOpen ? (
          <button
            onClick={(e) => {
              e.stopPropagation();
              setCustomPathOpen(true);
              setCustomPathError(null);
              deferFocus(() => customPathInputRef.current?.focus());
            }}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 7,
              width: "100%",
              padding: "8px 10px",
              background: "none",
              border: "none",
              color: "var(--text-muted)",
              cursor: "pointer",
              textAlign: "left",
              fontSize: 11,
            }}
          >
            <svg
              width="10"
              height="10"
              viewBox="0 0 10 10"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.1"
              strokeLinecap="round"
              style={{ flexShrink: 0 }}
            >
              <line x1="5" y1="1" x2="5" y2="9" />
              <line x1="1" y1="5" x2="9" y2="5" />
            </svg>
            <span>{t("customPath", "Custom path…")}</span>
          </button>
        ) : (
          <div style={{ padding: "6px 8px", borderTop: visibleProjects.length > 0 ? "none" : undefined }}>
            <input
              ref={customPathInputRef}
              value={customPathValue}
              onChange={(e) => {
                setCustomPathValue(e.target.value);
                setCustomPathError(null);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  void commitCustomPath();
                }
                if (e.key === "Escape") {
                  setCustomPathOpen(false);
                  setCustomPathValue("");
                  setCustomPathError(null);
                }
              }}
              placeholder="/path/to/project"
              style={{
                width: "100%",
                fontSize: 11,
                fontFamily: "var(--font-mono)",
                padding: "5px 8px",
                border: "1px solid var(--accent)",
                borderRadius: 5,
                outline: "none",
                background: "var(--bg)",
                color: "var(--text)",
                boxSizing: "border-box",
              }}
            />
            {customPathError && (
              <div
                style={{
                  marginTop: 5,
                  color: "#dc2626",
                  fontSize: 11,
                  lineHeight: 1.35,
                  overflowWrap: "anywhere",
                }}
              >
                {customPathError}
              </div>
            )}
            <div style={{ display: "flex", gap: 5, marginTop: 5 }}>
              <button
                onClick={() => void commitCustomPath()}
                disabled={customPathValidating || !customPathValue.trim()}
                style={{
                  flex: 1,
                  padding: "4px 0",
                  background: "var(--accent)",
                  border: "none",
                  borderRadius: 5,
                  color: "#fff",
                  fontSize: 11,
                  fontWeight: 600,
                  cursor: customPathValidating || !customPathValue.trim() ? "not-allowed" : "pointer",
                  opacity: customPathValidating || !customPathValue.trim() ? 0.65 : 1,
                }}
              >
                {customPathValidating ? t("checking", "Checking…") : t("open", "Open")}
              </button>
              <button
                onClick={() => {
                  setCustomPathOpen(false);
                  setCustomPathValue("");
                  setCustomPathError(null);
                }}
                style={{
                  flex: 1,
                  padding: "4px 0",
                  background: "var(--bg-hover)",
                  border: "1px solid var(--border)",
                  borderRadius: 5,
                  color: "var(--text-muted)",
                  fontSize: 11,
                  cursor: "pointer",
                }}
              >
                {t("cancel", "Cancel")}
              </button>
            </div>
          </div>
        )}
      </AnimatedDropdown>
    </div>
  );
}
