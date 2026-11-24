import { useEffect, useRef, useState } from "react";
import { RpcError, type SessionInfo } from "@contract/types";
import { useI18n } from "@/i18n";
import { call } from "@/lib/api-client";
import { sessionClientErrorMessage, unavailableSessionDirectoryMessage } from "@/lib/session-error-message";

type IncompleteTail = { directory: string; revision: string };

export function SessionDirectoryNotice({
  sessionId,
  cwd,
  onForked,
}: {
  sessionId: string;
  cwd: string;
  onForked?: (session: SessionInfo) => void;
}) {
  const { t } = useI18n();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [incompleteTail, setIncompleteTail] = useState<IncompleteTail | null>(null);
  const request = useRef<AbortController | null>(null);
  useEffect(() => () => request.current?.abort(), []);

  async function chooseDirectory(recovery?: IncompleteTail) {
    if (!onForked || request.current) return;
    const controller = new AbortController();
    request.current = controller;
    setPending(true);
    setError(null);
    setIncompleteTail(null);
    let directory: string | null = null;
    try {
      directory = recovery?.directory ?? (await window.piBridge.selectDirectory());
      if (!directory || controller.signal.aborted) return;
      const session = await call("sessions.forkToDirectory", {
        id: sessionId,
        cwd: directory,
        ...(recovery ? { confirmedIncompleteTail: recovery.revision } : {}),
      });
      if (!controller.signal.aborted) onForked(session);
    } catch (cause) {
      if (controller.signal.aborted) return;
      if (cause instanceof RpcError && cause.code === "SESSION_FORK_TARGET_UNAVAILABLE") {
        setError(
          t("sessionDirectoryForkTargetUnavailable", "The selected folder is unavailable. Choose another folder."),
        );
      } else if (cause instanceof RpcError && cause.code === "SESSION_FORK_BUSY") {
        setError(t("sessionDirectoryForkBusy", "Wait for the original session to finish before forking it."));
      } else {
        if (directory && cause instanceof RpcError && cause.code === "SESSION_FORK_INCOMPLETE_TAIL") {
          const revision = (cause.detail as { revision?: unknown } | undefined)?.revision;
          if (typeof revision === "string") setIncompleteTail({ directory, revision });
        }
        setError(
          sessionClientErrorMessage(cause, t, t("sessionDirectoryForkFailed", "Could not create the session copy.")),
        );
      }
    } finally {
      if (!controller.signal.aborted) {
        request.current = null;
        setPending(false);
      }
    }
  }

  return (
    <div className="relative z-[1] mx-4 my-2 shrink-0 rounded-md border border-[var(--border)] bg-[var(--bg-panel)] px-3 py-2 text-sm [overflow-wrap:anywhere]">
      <p role="status" style={{ color: "var(--warning)" }}>
        {unavailableSessionDirectoryMessage(cwd, t)}
      </p>
      {onForked && (
        <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-2">
          <button
            type="button"
            onClick={() => void chooseDirectory()}
            disabled={pending}
            className="cursor-pointer rounded-md border border-[var(--border)] bg-[var(--bg-hover)] px-3 py-1 text-[var(--text)] hover:border-[var(--accent)] disabled:cursor-wait disabled:opacity-60"
          >
            {pending
              ? t("sessionDirectoryForkPending", "Preparing session copy…")
              : t("sessionDirectoryForkAction", "Choose a new folder to continue")}
          </button>
          <p className="text-xs text-[var(--text-dim)]">
            {t(
              "sessionDirectoryForkHint",
              "Copies the history into a new chat-only session and keeps the original. You can choose tool permissions in the new session.",
            )}
          </p>
        </div>
      )}
      {error && (
        <p role="alert" className="mt-2 text-[var(--danger)]">
          {error}
        </p>
      )}
      {incompleteTail && (
        <button
          type="button"
          disabled={pending}
          className="mt-2 rounded-md border border-[var(--border)] px-3 py-1 text-[var(--text)] hover:border-[var(--accent)]"
          onClick={() => void chooseDirectory(incompleteTail)}
        >
          {t("sessionDirectoryForkRecoverTail", "Create a copy from complete records")}
        </button>
      )}
    </div>
  );
}
