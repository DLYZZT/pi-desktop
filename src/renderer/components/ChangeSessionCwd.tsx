import { useCallback, useEffect, useRef, useState } from "react";
import { getHome, listSessions, relocateSession, subscribeRunning, validateCwd } from "@/lib/api-client";
import { useI18n } from "@/i18n";
import { abbreviateHomePath } from "@/lib/display-path";
import type { SessionInfo } from "@/lib/types";

function recentProjectRoots(sessions: SessionInfo[]): string[] {
  const latestByRoot = new Map<string, string>();
  for (const session of sessions) {
    const root = session.projectRoot ?? session.cwd;
    if (!root) continue;
    const prev = latestByRoot.get(root);
    if (!prev || session.modified > prev) latestByRoot.set(root, session.modified);
  }
  return [...latestByRoot.entries()].sort((a, b) => b[1].localeCompare(a[1])).map(([root]) => root);
}

export function ChangeSessionCwd({
  cwd,
  sessionId,
  sessionPath,
  onRelocated,
}: {
  cwd: string;
  sessionId: string;
  sessionPath?: string;
  onRelocated: (session: SessionInfo) => void;
}) {
  const { t } = useI18n();
  const rootRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [projects, setProjects] = useState<string[]>([]);
  const [homeDir, setHomeDir] = useState<string | undefined>();
  const disabled = running || busy;

  useEffect(() => {
    if (!open) return;
    const onDown = (event: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  useEffect(() => {
    let cancelled = false;
    let unsubscribe: (() => void) | undefined;
    void subscribeRunning((event) => {
      if (!cancelled) setRunning(event.sessionIds.includes(sessionId));
    }).then((stop) => {
      if (cancelled) stop();
      else unsubscribe = stop;
    });
    return () => {
      cancelled = true;
      unsubscribe?.();
    };
  }, [sessionId]);

  const openPicker = useCallback(async () => {
    if (disabled) return;
    setError(null);
    if (open) {
      setOpen(false);
      return;
    }
    setOpen(true);
    try {
      const result = await listSessions();
      setProjects(recentProjectRoots(result.sessions).filter((project) => project !== cwd));
      setRunning(result.runningSessionIds.includes(sessionId));
      const home = await getHome().catch(() => ({ home: "" }));
      if (home.home) setHomeDir(home.home);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [cwd, disabled, open, sessionId]);

  const applyCwd = useCallback(
    async (nextCwd: string) => {
      if (disabled) return;
      setBusy(true);
      setError(null);
      try {
        const validated = await validateCwd(nextCwd);
        if (!validated.ok || !validated.path) {
          setError(validated.error ?? t("invalidDirectory", "Invalid directory"));
          return;
        }
        const dest = validated.path;
        if (!sessionPath) {
          onRelocated({
            id: sessionId,
            cwd: dest,
            path: "",
            created: new Date().toISOString(),
            modified: new Date().toISOString(),
            messageCount: 0,
            firstMessage: "",
            projectRoot: dest,
          });
          setOpen(false);
          return;
        }
        const { session } = await relocateSession(sessionId, dest);
        onRelocated(session);
        setOpen(false);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setBusy(false);
      }
    },
    [disabled, onRelocated, sessionId, sessionPath, t],
  );

  const browse = useCallback(async () => {
    const dir = await window.piBridge?.selectDirectory?.();
    if (dir) await applyCwd(dir);
  }, [applyCwd]);

  return (
    <div ref={rootRef} style={{ position: "relative", display: "inline-flex" }}>
      <button
        type="button"
        disabled={disabled}
        title={
          running
            ? t("changeWorkingDirectoryIdleOnly", "Stop the current turn before changing folders")
            : t("changeWorkingDirectory", "Change working directory")
        }
        aria-label={t("changeWorkingDirectory", "Change working directory")}
        aria-expanded={open}
        onClick={() => void openPicker()}
        style={{
          minWidth: 48,
          height: 22,
          padding: "0 7px",
          color: disabled ? "var(--text-dim)" : "var(--text-muted)",
          background: open ? "var(--bg-selected)" : "transparent",
          border: "1px solid var(--border)",
          borderRadius: 4,
          cursor: disabled ? "not-allowed" : "pointer",
          fontSize: 11,
        }}
      >
        {t("changeWorkingDirectoryShort", "Change")}
      </button>
      {open && (
        <div
          style={{
            position: "absolute",
            top: "100%",
            right: 0,
            zIndex: 60,
            width: 320,
            marginTop: 4,
            background: "var(--bg-panel)",
            border: "1px solid var(--border)",
            borderRadius: 6,
            boxShadow: "0 10px 28px rgba(0,0,0,0.12)",
            overflow: "hidden",
          }}
        >
          <div style={{ maxHeight: 240, overflowY: "auto" }}>
            {projects.map((project) => (
              <button
                key={project}
                type="button"
                disabled={busy}
                title={project}
                onClick={() => void applyCwd(project)}
                style={{
                  display: "block",
                  width: "100%",
                  padding: "8px 10px",
                  background: "none",
                  border: "none",
                  borderBottom: "1px solid var(--border)",
                  color: "var(--text)",
                  cursor: busy ? "wait" : "pointer",
                  fontFamily: "var(--font-mono)",
                  fontSize: 11,
                  textAlign: "left",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
              >
                {abbreviateHomePath(project, homeDir)}
              </button>
            ))}
          </div>
          {typeof window !== "undefined" && !!window.piBridge && (
            <button
              type="button"
              disabled={busy}
              onClick={() => void browse()}
              style={{
                display: "block",
                width: "100%",
                padding: "8px 10px",
                background: "none",
                border: "none",
                borderTop: projects.length > 0 ? undefined : "1px solid var(--border)",
                color: "var(--text-muted)",
                cursor: busy ? "wait" : "pointer",
                fontSize: 11,
                textAlign: "left",
              }}
            >
              {t("browseFolder", "Browse folder…")}
            </button>
          )}
          {error && (
            <div role="alert" style={{ padding: "8px 10px", color: "var(--error, #ef4444)", fontSize: 11 }}>
              {error}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
