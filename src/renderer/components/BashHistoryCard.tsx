import { BashOutputActions } from "./BashOutputActions";
import { useI18n } from "@/i18n";
import { scaledChatFont } from "@/lib/chat-appearance";
import type { BashHistoryMessage, LoadDeferredContent } from "@/lib/types";
import { DeferredContentActions } from "./DeferredContentActions";

export function BashHistoryCard({
  message,
  onLoad,
  sessionId,
  entryId,
}: {
  sessionId?: string;
  entryId?: string;
  message: BashHistoryMessage;
  onLoad?: LoadDeferredContent;
}) {
  const { t } = useI18n();
  const [command, output] = message.content;
  const { fullOutputError, fullOutputPath } = message;
  return (
    <section
      className="bash-history-card"
      aria-label={t("cliBashCommand", "CLI shell command")}
      style={{ fontSize: scaledChatFont(12) }}
    >
      <pre className="bash-history-command">
        <code>
          {message.excludeFromContext ? "!!" : "!"}
          {command?.text}
        </code>
      </pre>
      <pre className="bash-history-output">{output?.text || t("cliBashEmpty", "(no output)")}</pre>
      <div className="bash-history-info">
        {message.cancelled && <span>{t("cliBashCancelled", "Cancelled")}</span>}
        {typeof message.exitCode === "number" && (
          <span>{t("cliBashExit", "Exit code {code}").replace("{code}", String(message.exitCode))}</span>
        )}
        {message.excludeFromContext && <span>{t("cliBashExcluded", "Excluded from model context")}</span>}
        {message.truncated && (
          <span>
            {fullOutputError
              ? t("cliBashSaveFailed", "Output truncated. Could not save the full output. {reason}").replace(
                  "{reason}",
                  () => fullOutputError,
                )
              : fullOutputPath
                ? t("cliBashSaved", "Output truncated. Full output saved to {path}").replace(
                    "{path}",
                    () => fullOutputPath,
                  )
                : t("cliBashTruncated", "Output truncated")}
          </span>
        )}
      </div>
      {fullOutputPath && message.truncated && !fullOutputError && (
        <BashOutputActions key={fullOutputPath} path={fullOutputPath} sessionId={sessionId} entryId={entryId} />
      )}
      <DeferredContentActions content={message.content} onLoad={onLoad} />
    </section>
  );
}
