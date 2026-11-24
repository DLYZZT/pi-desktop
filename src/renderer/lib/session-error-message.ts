import { RpcError } from "../../contract/types.ts";

type Translate = (key: string, fallback: string) => string;

interface EventStreamError extends Error {
  name: "EventStreamConnectionError";
  status: "timeout" | "closed";
}

function isEventStreamError(error: unknown): error is EventStreamError {
  if (!(error instanceof Error) || error.name !== "EventStreamConnectionError") return false;
  const status = (error as { status?: unknown }).status;
  return status === "timeout" || status === "closed";
}

export function unavailableSessionDirectoryMessage(cwd: string, t: Translate): string {
  return t(
    "sessionWorkingDirectoryUnavailable",
    "The session's working directory is unavailable ({cwd}). Restore it to resume this session.",
  ).replace("{cwd}", () => cwd);
}

export function sessionClientErrorMessage(error: unknown, t: Translate, fallback: string): string {
  if (isEventStreamError(error)) {
    return error.status === "timeout"
      ? t("agentEventStreamTimeout", "Timed out connecting to the agent event stream. Please try again.")
      : t("agentEventStreamConnectFailed", "Failed to connect to the agent event stream. Please try again.");
  }
  if (error instanceof RpcError && error.code === "SESSION_CWD_UNAVAILABLE") {
    const cwd = (error.detail as { cwd?: unknown } | undefined)?.cwd;
    if (typeof cwd === "string") return unavailableSessionDirectoryMessage(cwd, t);
  }
  if (error instanceof RpcError && error.code === "SESSION_FORK_SOURCE_CHANGED")
    return t(
      "sessionDirectoryForkSourceChanged",
      "The source history has changed. Choose the folder again to copy the current history.",
    );
  if (
    error instanceof RpcError &&
    ["SESSION_FORK_INCOMPLETE_TAIL", "SESSION_FORK_INVALID_HISTORY"].includes(error.code)
  ) {
    const line = (error.detail as { line?: number } | undefined)?.line;
    const message =
      error.code === "SESSION_FORK_INCOMPLETE_TAIL"
        ? t(
            "sessionDirectoryForkIncompleteTail",
            "The last record (line {line}) is incomplete. You can copy the complete records to the selected folder. The original file is preserved.",
          )
        : t(
            "sessionDirectoryForkInvalidHistory",
            "The history file contains a damaged record at line {line}. Restore the session file from a backup and try again, or start a new session in the selected folder.",
          );
    return message.replace("{line}", String(line ?? "?"));
  }
  if (error instanceof TypeError) return fallback;
  if (error instanceof Error && error.message) return error.message;
  return fallback;
}
