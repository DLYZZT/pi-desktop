import { useRef, useState } from "react";
import type { BashOutputPage } from "@contract/types";
import { useI18n } from "@/i18n";
import { useCopyFeedback } from "@/hooks/useCopyFeedback";
import { call } from "@/lib/api-client";

export function BashOutputActions({
  path,
  sessionId,
  entryId,
}: {
  path: string;
  sessionId?: string;
  entryId?: string;
}) {
  const { t } = useI18n();
  const { copy, copied } = useCopyFeedback();
  const [copyFailed, setCopyFailed] = useState(false);
  const [page, setPage] = useState<BashOutputPage>();
  const [back, setBack] = useState<number[]>([]);
  const [loading, setLoading] = useState(false);
  const generation = useRef(0);
  async function show(offset: number, trail: number[]) {
    if (!sessionId || !entryId) return;
    const request = ++generation.current;
    setLoading(true);
    try {
      const result = await call("sessions.bashOutput", { id: sessionId, entryId, offset });
      if (generation.current === request) {
        setPage(result);
        setBack(trail);
      }
    } catch {
      if (generation.current === request) setPage({ status: "unavailable" });
    } finally {
      if (generation.current === request) setLoading(false);
    }
  }
  return (
    <>
      <div className="bash-history-actions">
        <button type="button" onClick={async () => setCopyFailed(!(await copy(path)))}>
          {copied ? t("copied", "Copied") : t("bashCopyPath", "Copy path")}
        </button>
        {copyFailed && <span role="status">{t("bashCopyFailed", "Could not copy the path.")}</span>}
        {sessionId && entryId && (
          <button
            type="button"
            aria-expanded={!!page}
            disabled={loading}
            onClick={() => (page ? setPage(undefined) : void show(0, []))}
          >
            {loading
              ? t("loading", "Loading…")
              : page
                ? t("bashClosePreview", "Close preview")
                : t("bashPreview", "Preview full output")}
          </button>
        )}
      </div>
      {page?.status === "ready" ? (
        <>
          <pre tabIndex={0} aria-label={t("bashPreview", "Preview full output")}>
            {page.text || t("cliBashEmpty", "(no output)")}
          </pre>
          <div className="bash-history-actions">
            <span>
              {t("bashPreviewRange", "Bytes {start}–{end} of {total}")
                .replace("{start}", String(page.totalBytes ? page.offset + 1 : 0))
                .replace("{end}", String(page.nextOffset ?? page.totalBytes))
                .replace("{total}", String(page.totalBytes))}
            </span>
            {back.length > 0 && (
              <button disabled={loading} onClick={() => void show(back[back.length - 1], back.slice(0, -1))}>
                {t("bashPreviousPage", "Previous page")}
              </button>
            )}
            {page.nextOffset !== undefined && (
              <button disabled={loading} onClick={() => void show(page.nextOffset!, [...back, page.offset])}>
                {t("bashNextPage", "Next page")}
              </button>
            )}
          </div>
        </>
      ) : (
        page && (
          <div className="bash-history-info" role="status">
            {page.status === "missing"
              ? t("bashOutputExpired", "The temporary output file has expired or was removed.")
              : page.status === "untrusted"
                ? t("bashOutputUntrusted", "Only Pi's temporary shell output files can be previewed.")
                : t("bashOutputUnavailable", "The output file could not be read.")}
          </div>
        )
      )}
    </>
  );
}
