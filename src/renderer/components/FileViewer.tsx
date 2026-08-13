import { useEffect, useState, useRef, useCallback, useMemo, useReducer } from "react";
import { SyntaxHighlighter, vs, vscDarkPlus } from "@/lib/syntax-highlight";
import { useTheme } from "@/hooks/useTheme";
import { MarkdownBody } from "./MarkdownBody";
import { DOCX_PREVIEW_MAX_BYTES, getFileExt, isAudioPath, isDocumentPreviewPath, isImagePath } from "@/lib/file-types";
import { createDocxPreviewHtml } from "@/lib/docx-preview-html";
import { encodeFilePathForApi, getFileName, getParentFilePath, getRelativeFilePath } from "@/lib/file-paths";
import { INITIAL_TEXT_FILE_LOAD_STATE, textFileLoadReducer, type TextFileData } from "@/lib/file-viewer-load-state";
import { createBoundedTextDiff, type DiffLine } from "@/lib/text-diff";
import { useI18n } from "@/i18n";
import { formatFileSize, formatNumber } from "@/lib/locale-format";

interface Props {
  filePath: string;
  cwd?: string;
  sourceSessionId?: string | null;
}

function getFileApiUrl(
  filePath: string,
  type: "read" | "download" | "meta" | "preview" | "watch",
  sourceSessionId?: string | null,
  params: Record<string, string | number | undefined> = {},
): string {
  const encoded = encodeFilePathForApi(filePath);
  const searchParams = new URLSearchParams({ type });
  if (sourceSessionId) searchParams.set("sessionId", sourceSessionId);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) searchParams.set(key, String(value));
  }
  return `/api/files/${encoded}?${searchParams.toString()}`;
}

function DownloadLink({ filePath, sourceSessionId }: { filePath: string; sourceSessionId?: string | null }) {
  const { t } = useI18n();
  const [busy, setBusy] = useState(false);
  return (
    <button
      type="button"
      title={t("downloadFile", "Download file")}
      aria-label={t("downloadFile", "Download file")}
      disabled={busy}
      onClick={() => {
        setBusy(true);
        void import("@/lib/file-blob")
          .then(({ downloadFileViaRpc }) => downloadFileViaRpc(filePath, getFileName(filePath), sourceSessionId))
          .catch((e) => console.error("download failed", e))
          .finally(() => setBusy(false));
      }}
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        width: 32,
        height: 32,
        padding: 0,
        background: "var(--bg-panel)",
        border: "1px solid var(--border)",
        borderRadius: 4,
        color: "var(--text-muted)",
        cursor: busy ? "wait" : "pointer",
        flexShrink: 0,
      }}
    >
      <svg
        width="11"
        height="11"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.2"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
        <polyline points="7 10 12 15 17 10" />
        <line x1="12" y1="15" x2="12" y2="3" />
      </svg>
    </button>
  );
}

function HtmlPreview({
  content,
  filePath,
  sourceSessionId,
}: {
  content: string;
  filePath: string;
  sourceSessionId?: string | null;
}) {
  const { t } = useI18n();
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);

  useEffect(() => {
    let disposed = false;
    let activeUrl: string | null = null;
    setPreviewUrl(null);
    setPreviewError(null);

    void window.piBridge
      .createHtmlPreview(content, filePath, sourceSessionId)
      .then((url) => {
        if (disposed) {
          void window.piBridge.releaseHtmlPreview(url).catch(() => {});
          return;
        }
        activeUrl = url;
        setPreviewUrl(url);
      })
      .catch((error) => {
        if (!disposed) setPreviewError(error instanceof Error ? error.message : String(error));
      });

    return () => {
      disposed = true;
      if (activeUrl) void window.piBridge.releaseHtmlPreview(activeUrl).catch(() => {});
    };
  }, [content, filePath, sourceSessionId]);

  if (previewError) {
    return (
      <div
        role="alert"
        style={{
          height: "100%",
          display: "grid",
          placeItems: "center",
          padding: 20,
          color: "var(--danger)",
          fontSize: 13,
          textAlign: "center",
        }}
      >
        {t("htmlPreviewFailed", "HTML preview could not be created: {error}").replace("{error}", previewError)}
      </div>
    );
  }

  if (!previewUrl) return null;

  return (
    <iframe
      key={previewUrl}
      src={previewUrl}
      sandbox="allow-scripts"
      referrerPolicy="no-referrer"
      style={{ display: "block", width: "100%", height: "100%", border: "none", background: "var(--bg)" }}
      title={t("htmlPreview", "HTML preview")}
    />
  );
}

function DiffView({ oldContent, newContent }: { oldContent: string; newContent: string }) {
  const { language, t } = useI18n();
  const result = useMemo(() => createBoundedTextDiff(oldContent, newContent), [oldContent, newContent]);
  if (result.kind === "fallback") {
    return (
      <div role="status" style={{ padding: 16, color: "var(--text-muted)", fontSize: 12, lineHeight: 1.6 }}>
        {t(
          "diffTooLarge",
          "Diff is too large to render safely. The file changed from {oldLines} to {newLines} lines; showing the current source avoids freezing the app.",
        )
          .replace("{oldLines}", formatNumber(result.oldLines, language))
          .replace("{newLines}", formatNumber(result.newLines, language))}
      </div>
    );
  }
  const diff = result.lines;

  const hasChanges = diff.some((l) => l.type !== "unchanged");
  if (!hasChanges) {
    return (
      <div style={{ padding: "12px 16px", fontSize: 12, color: "var(--text-dim)", fontFamily: "var(--font-mono)" }}>
        {t("noChanges", "No changes")}
      </div>
    );
  }

  // Render with context: show 3 lines around each change, collapse the rest
  const CONTEXT = 3;
  const changed = new Set(diff.flatMap((l, i) => (l.type !== "unchanged" ? [i] : [])));
  const visible = new Set<number>();
  for (const ci of changed) {
    for (let j = Math.max(0, ci - CONTEXT); j <= Math.min(diff.length - 1, ci + CONTEXT); j++) {
      visible.add(j);
    }
  }

  const segments: Array<{ hidden: true; count: number } | { hidden: false; lines: DiffLine[] }> = [];
  let i = 0;
  while (i < diff.length) {
    if (visible.has(i)) {
      const block: DiffLine[] = [];
      while (i < diff.length && visible.has(i)) {
        block.push(diff[i]);
        i++;
      }
      segments.push({ hidden: false, lines: block });
    } else {
      let count = 0;
      while (i < diff.length && !visible.has(i)) {
        count++;
        i++;
      }
      segments.push({ hidden: true, count });
    }
  }

  // Track running line number for added/unchanged lines
  const newLineNos: number[] = [];
  let nlo = 1;
  for (const line of diff) {
    if (line.type === "removed") {
      newLineNos.push(0);
    } else {
      newLineNos.push(nlo++);
    }
  }

  let diffIdx = 0;

  return (
    <div style={{ fontFamily: "var(--font-mono)", fontSize: 13, lineHeight: 1.6 }}>
      {segments.map((seg, si) => {
        if (seg.hidden) {
          const result = (
            <div
              key={si}
              style={{
                padding: "2px 16px",
                color: "var(--text-dim)",
                background: "var(--bg-panel)",
                fontSize: 11,
                borderTop: "1px solid var(--border)",
                borderBottom: "1px solid var(--border)",
              }}
            >
              {t("unchangedLines", "… {count} unchanged lines …").replace("{count}", formatNumber(seg.count, language))}
            </div>
          );
          diffIdx += seg.count;
          return result;
        }
        const lines = seg.lines.map((line, li) => {
          const idx = diffIdx + li;
          const newLno = newLineNos[idx];
          const bg =
            line.type === "added"
              ? "rgba(0,200,80,0.12)"
              : line.type === "removed"
                ? "rgba(240,60,60,0.14)"
                : "transparent";
          const prefix = line.type === "added" ? "+" : line.type === "removed" ? "-" : " ";
          const prefixColor =
            line.type === "added" ? "var(--success)" : line.type === "removed" ? "var(--danger)" : "var(--text-dim)";

          return (
            <div
              key={li}
              style={{
                display: "flex",
                background: bg,
                borderLeft:
                  line.type === "added"
                    ? "3px solid var(--success)"
                    : line.type === "removed"
                      ? "3px solid var(--danger)"
                      : "3px solid transparent",
              }}
            >
              <span
                style={{
                  minWidth: 44,
                  padding: "0 8px 0 16px",
                  textAlign: "right",
                  color: "var(--text-dim)",
                  userSelect: "none",
                  fontSize: 11,
                  lineHeight: 1.6,
                  borderRight: "1px solid var(--border)",
                  background: "var(--bg-panel)",
                  flexShrink: 0,
                }}
              >
                {line.type === "removed" ? line.lineNo : newLno || ""}
              </span>
              <span
                style={{
                  minWidth: 16,
                  padding: "0 6px",
                  color: prefixColor,
                  userSelect: "none",
                  flexShrink: 0,
                  fontWeight: 600,
                }}
              >
                {prefix}
              </span>
              <span
                style={{
                  flex: 1,
                  padding: "0 8px 0 0",
                  whiteSpace: "pre",
                  color: "var(--text)",
                  overflowX: "auto",
                }}
              >
                {line.text || "\u00a0"}
              </span>
            </div>
          );
        });
        diffIdx += seg.lines.length;
        return <div key={si}>{lines}</div>;
      })}
    </div>
  );
}

/** ISSUE-004: load media via RPC → Blob URL (not bare /api img src) */
function useBlobSrc(filePath: string, sourceSessionId?: string | null, bust = 0) {
  const [src, setSrc] = useState<string | null>(null);
  const [size, setSize] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const revokeRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    let cancelled = false;
    setError(null);
    revokeRef.current?.();
    revokeRef.current = null;
    setSrc(null);
    void import("@/lib/file-blob")
      .then(({ fileToObjectUrl }) => fileToObjectUrl(filePath, sourceSessionId))
      .then((r) => {
        if (cancelled) {
          r.revoke();
          return;
        }
        revokeRef.current = r.revoke;
        setSrc(r.url);
        setSize(r.size);
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      cancelled = true;
      revokeRef.current?.();
      revokeRef.current = null;
    };
  }, [filePath, sourceSessionId, bust]);

  return { src, size, error, setError, setSize };
}

function useFileWatch(filePath: string, sourceSessionId: string | null | undefined, onChange: (size?: number) => void) {
  const [watching, setWatching] = useState(false);
  useEffect(() => {
    setWatching(false);
    const es = new EventSource(getFileApiUrl(filePath, "watch", sourceSessionId));
    es.addEventListener("connected", () => setWatching(true));
    es.addEventListener("change", (e) => {
      try {
        const d = JSON.parse((e as MessageEvent).data) as { size?: number };
        onChange(typeof d.size === "number" ? d.size : undefined);
      } catch {
        onChange();
      }
    });
    es.addEventListener("error", () => setWatching(false));
    es.onerror = () => setWatching(false);
    return () => es.close();
  }, [filePath, sourceSessionId, onChange]);
  return watching;
}

function ImageViewer({ filePath, cwd, sourceSessionId }: Props) {
  const { language, t } = useI18n();
  const [bust, setBust] = useState(0);
  const [naturalSize, setNaturalSize] = useState<{ w: number; h: number } | null>(null);
  const { src, size, error, setError, setSize } = useBlobSrc(filePath, sourceSessionId, bust);
  const onChange = useCallback(
    (s?: number) => {
      if (typeof s === "number") setSize(s);
      setNaturalSize(null);
      setBust((b) => b + 1);
    },
    [setSize],
  );
  const watching = useFileWatch(filePath, sourceSessionId, onChange);

  const ext = getFileName(filePath).toLowerCase().split(".").pop() ?? "";

  const formatSizeStr = size != null ? formatFileSize(size, language) : null;

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", overflow: "hidden" }}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 12,
          minHeight: 40,
          padding: "4px 12px",
          borderBottom: "1px solid var(--border)",
          fontSize: 12,
          color: "var(--text-dim)",
          background: "var(--bg)",
          flexShrink: 0,
          overflowX: "auto",
          whiteSpace: "nowrap",
        }}
      >
        <span style={{ fontFamily: "var(--font-mono)" }} title={filePath}>
          {getRelativeFilePath(filePath, cwd)}
        </span>
        <span style={{ marginLeft: "auto" }}>{ext || "image"}</span>
        {naturalSize && (
          <span>
            {naturalSize.w} × {naturalSize.h}
          </span>
        )}
        {formatSizeStr && <span>{formatSizeStr}</span>}
        <span
          title={watching ? t("liveSyncActive", "Live sync active") : t("notWatching", "Not watching")}
          style={{
            display: "flex",
            alignItems: "center",
            gap: 4,
            color: watching ? "var(--success)" : "var(--text-dim)",
          }}
        >
          <span
            style={{
              width: 7,
              height: 7,
              borderRadius: "50%",
              background: watching ? "var(--success)" : "var(--border)",
              display: "inline-block",
              boxShadow: watching ? "0 0 4px var(--success)" : "none",
            }}
          />
          {watching ? t("live", "live") : t("static", "static")}
        </span>
        <DownloadLink filePath={filePath} sourceSessionId={sourceSessionId} />
      </div>
      <div
        style={{
          flex: 1,
          overflow: "auto",
          background: "var(--bg-panel)",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          padding: 16,
          backgroundImage:
            "linear-gradient(45deg, var(--bg) 25%, transparent 25%), linear-gradient(-45deg, var(--bg) 25%, transparent 25%), linear-gradient(45deg, transparent 75%, var(--bg) 75%), linear-gradient(-45deg, transparent 75%, var(--bg) 75%)",
          backgroundSize: "16px 16px",
          backgroundPosition: "0 0, 0 8px, 8px -8px, -8px 0px",
        }}
      >
        {error ? (
          <div style={{ color: "var(--danger)", fontSize: 13 }}>{error}</div>
        ) : !src ? (
          <div style={{ color: "var(--text-muted)", fontSize: 13 }}>{t("loading", "Loading…")}</div>
        ) : (
          <img
            src={src}
            alt={filePath}
            onLoad={(e) => {
              const img = e.currentTarget;
              setNaturalSize({ w: img.naturalWidth, h: img.naturalHeight });
            }}
            onError={() => setError(t("imageLoadFailed", "Failed to load image"))}
            style={{
              maxWidth: "100%",
              maxHeight: "100%",
              objectFit: "contain",
              boxShadow: "0 2px 8px rgba(0,0,0,0.15)",
            }}
          />
        )}
      </div>
    </div>
  );
}

function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds)) return "";
  const totalSeconds = Math.round(seconds);
  const mins = Math.floor(totalSeconds / 60);
  const secs = totalSeconds % 60;
  return `${mins}:${String(secs).padStart(2, "0")}`;
}

function AudioViewer({ filePath, cwd, sourceSessionId }: Props) {
  const { language, t } = useI18n();
  const [bust, setBust] = useState(0);
  const [duration, setDuration] = useState<number | null>(null);
  const { src, size, error, setError, setSize } = useBlobSrc(filePath, sourceSessionId, bust);
  const onChange = useCallback(
    (s?: number) => {
      if (typeof s === "number") setSize(s);
      setDuration(null);
      setError(null);
      setBust((b) => b + 1);
    },
    [setSize, setError],
  );
  const watching = useFileWatch(filePath, sourceSessionId, onChange);

  const ext = getFileName(filePath).toLowerCase().split(".").pop() ?? "";

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", overflow: "hidden" }}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 12,
          minHeight: 40,
          padding: "4px 12px",
          borderBottom: "1px solid var(--border)",
          fontSize: 12,
          color: "var(--text-dim)",
          background: "var(--bg)",
          flexShrink: 0,
          overflowX: "auto",
          whiteSpace: "nowrap",
        }}
      >
        <span style={{ fontFamily: "var(--font-mono)" }} title={filePath}>
          {getRelativeFilePath(filePath, cwd)}
        </span>
        <span style={{ marginLeft: "auto" }}>{ext || "audio"}</span>
        {duration != null && <span>{formatDuration(duration)}</span>}
        {size != null && <span>{formatFileSize(size, language)}</span>}
        <span
          title={watching ? t("liveSyncActive", "Live sync active") : t("notWatching", "Not watching")}
          style={{
            display: "flex",
            alignItems: "center",
            gap: 4,
            color: watching ? "var(--success)" : "var(--text-dim)",
          }}
        >
          <span
            style={{
              width: 7,
              height: 7,
              borderRadius: "50%",
              background: watching ? "var(--success)" : "var(--border)",
              display: "inline-block",
              boxShadow: watching ? "0 0 4px var(--success)" : "none",
            }}
          />
          {watching ? t("live", "live") : t("static", "static")}
        </span>
        <DownloadLink filePath={filePath} sourceSessionId={sourceSessionId} />
      </div>
      <div
        style={{
          flex: 1,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          padding: 24,
          background: "var(--bg-panel)",
        }}
      >
        <div style={{ width: "min(680px, 100%)" }}>
          {error && (
            <div style={{ color: "var(--danger)", fontSize: 13, marginBottom: 12, textAlign: "center" }}>{error}</div>
          )}
          {src && (
            <audio
              key={src}
              controls
              preload="metadata"
              src={src}
              onLoadedMetadata={(e) => setDuration(e.currentTarget.duration)}
              onError={() => setError(t("audioLoadFailed", "Failed to load audio"))}
              style={{ width: "100%" }}
            />
          )}
        </div>
      </div>
    </div>
  );
}

function DocumentViewer({ filePath, cwd, sourceSessionId }: Props) {
  const { isDark } = useTheme();
  const { language, t } = useI18n();
  const [bust, setBust] = useState(0);
  const [size, setSize] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const revokeRef = useRef<(() => void) | null>(null);

  const ext = getFileExt(filePath);
  const isPdf = ext === "pdf";

  useEffect(() => {
    let cancelled = false;
    setError(null);
    setSize(null);
    revokeRef.current?.();
    revokeRef.current = null;
    setPreviewUrl(null);

    void (async () => {
      try {
        if (isPdf) {
          const { fileToObjectUrl } = await import("@/lib/file-blob");
          const r = await fileToObjectUrl(filePath, sourceSessionId);
          if (cancelled) {
            r.revoke();
            return;
          }
          revokeRef.current = r.revoke;
          setPreviewUrl(r.url);
          setSize(r.size);
          return;
        }
        // DOCX: load base64, convert with mammoth client-side
        const { call } = await import("@/lib/api-client");
        const preview = await call("files.preview", {
          path: filePath,
          sourceSessionId: sourceSessionId ?? undefined,
        });
        if (cancelled) return;
        if (preview.kind === "too_large") {
          setError(t("docxTooLarge", "DOCX is too large for preview (>10 MB)"));
          return;
        }
        if (preview.kind === "docx" && preview.base64) {
          const mammoth = await import("mammoth");
          const binary = Uint8Array.from(atob(preview.base64), (c) => c.charCodeAt(0));
          const result = await mammoth.convertToHtml(
            { arrayBuffer: binary.buffer },
            { convertImage: mammoth.images.dataUri },
          );
          if (cancelled) return;
          const html = createDocxPreviewHtml(result.value, isDark ? "dark" : "light");
          const blob = new Blob([html], { type: "text/html;charset=utf-8" });
          const url = URL.createObjectURL(blob);
          revokeRef.current = () => URL.revokeObjectURL(url);
          setPreviewUrl(url);
        } else {
          setError(t("previewUnavailable", "Preview not available"));
        }
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      }
    })();

    return () => {
      cancelled = true;
      revokeRef.current?.();
      revokeRef.current = null;
    };
  }, [filePath, isDark, isPdf, sourceSessionId, bust, t]);

  const onChange = useCallback(
    (s?: number) => {
      if (typeof s === "number") {
        setSize(s);
        if (!isPdf && s > DOCX_PREVIEW_MAX_BYTES) {
          setError(t("docxTooLarge", "DOCX is too large for preview (>10 MB)"));
          return;
        }
      }
      setError(null);
      setBust((b) => b + 1);
    },
    [isPdf, t],
  );
  const watching = useFileWatch(filePath, sourceSessionId, onChange);

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", overflow: "hidden" }}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 12,
          minHeight: 40,
          padding: "4px 12px",
          borderBottom: "1px solid var(--border)",
          fontSize: 12,
          color: "var(--text-dim)",
          background: "var(--bg)",
          flexShrink: 0,
          overflowX: "auto",
          whiteSpace: "nowrap",
        }}
      >
        <span
          style={{ fontFamily: "var(--font-mono)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
          title={filePath}
        >
          {getRelativeFilePath(filePath, cwd)}
        </span>
        <span style={{ marginLeft: "auto" }}>{ext === "docx" ? t("docxPreview", "DOCX preview") : "PDF"}</span>
        {size != null && <span>{formatFileSize(size, language)}</span>}
        <DownloadLink filePath={filePath} sourceSessionId={sourceSessionId} />
        <span
          title={watching ? t("liveSyncActive", "Live sync active") : t("notWatching", "Not watching")}
          style={{
            display: "flex",
            alignItems: "center",
            gap: 4,
            color: watching ? "var(--success)" : "var(--text-dim)",
            flexShrink: 0,
          }}
        >
          <span
            style={{
              width: 7,
              height: 7,
              borderRadius: "50%",
              background: watching ? "var(--success)" : "var(--border)",
              display: "inline-block",
              boxShadow: watching ? "0 0 4px var(--success)" : "none",
            }}
          />
          {watching ? t("live", "live") : t("static", "static")}
        </span>
      </div>
      <div style={{ flex: 1, minHeight: 0, background: "var(--bg-panel)" }}>
        {error ? (
          <div
            style={{
              height: "100%",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              padding: 24,
              color: "var(--danger)",
              fontSize: 13,
              textAlign: "center",
            }}
          >
            {error}
          </div>
        ) : !previewUrl ? (
          <div
            style={{
              height: "100%",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              color: "var(--text-muted)",
              fontSize: 13,
            }}
          >
            {t("loading", "Loading…")}
          </div>
        ) : (
          <iframe
            key={previewUrl}
            src={previewUrl}
            sandbox={isPdf ? undefined : ""}
            title={t("filePreviewTitle", "Preview {name}").replace("{name}", getFileName(filePath))}
            style={{ width: "100%", height: "100%", border: "none", background: "var(--bg)" }}
          />
        )}
      </div>
    </div>
  );
}

export function FileViewer({ filePath, cwd, sourceSessionId }: Props) {
  if (isImagePath(filePath)) {
    return <ImageViewer filePath={filePath} cwd={cwd} sourceSessionId={sourceSessionId} />;
  }
  if (isAudioPath(filePath)) {
    return <AudioViewer filePath={filePath} cwd={cwd} sourceSessionId={sourceSessionId} />;
  }
  if (isDocumentPreviewPath(filePath)) {
    return <DocumentViewer filePath={filePath} cwd={cwd} sourceSessionId={sourceSessionId} />;
  }
  return <TextFileViewer filePath={filePath} cwd={cwd} sourceSessionId={sourceSessionId} />;
}

function TextFileViewer({ filePath, cwd, sourceSessionId }: Props) {
  const { isDark } = useTheme();
  const { language, t } = useI18n();
  const [loadState, dispatchLoad] = useReducer(textFileLoadReducer, INITIAL_TEXT_FILE_LOAD_STATE);
  const [previewMode, setPreviewMode] = useState(false);
  const [viewMode, setViewMode] = useState<"source" | "diff">("source");
  const [wrapLines, setWrapLines] = useState(false);
  const [watching, setWatching] = useState(false);
  const esRef = useRef<EventSource | null>(null);

  const loadGen = useRef(0);

  const fetchContent = useCallback(
    (targetPath: string, isRefresh = false) => {
      const gen = ++loadGen.current;
      return import("@/lib/file-blob")
        .then(({ readFilePayload }) => readFilePayload(targetPath, sourceSessionId))
        .then((d) => {
          if (gen !== loadGen.current) return null; // ISSUE-019: stale response
          if (d.error) {
            dispatchLoad({ type: "failed", error: d.error });
            return null;
          }
          if (d.encoding === "too_large") {
            dispatchLoad({ type: "failed", error: t("fileTooLargeForPreview", "File is too large for preview") });
            return null;
          }
          if (d.encoding === "base64") {
            dispatchLoad({
              type: "failed",
              error: t("binaryFileCannotShowText", "Binary file cannot be shown as text"),
            });
            return null;
          }
          const payload: TextFileData = {
            content: d.content,
            language: d.language ?? "text",
            size: d.size ?? d.content.length,
          };
          dispatchLoad({ type: "succeeded", data: payload, refresh: isRefresh });
          return payload;
        })
        .catch((e) => {
          if (gen !== loadGen.current) return null;
          dispatchLoad({ type: "failed", error: String(e) });
          return null;
        });
    },
    [sourceSessionId, t],
  );

  // Initial load + watch setup
  useEffect(() => {
    dispatchLoad({ type: "reset" });
    setPreviewMode(false);
    setViewMode("source");
    setWrapLines(false);
    setWatching(false);

    if (esRef.current) {
      esRef.current.close();
      esRef.current = null;
    }

    void fetchContent(filePath).then((data) => {
      if (data?.language === "markdown") setPreviewMode(true);
    });

    const es = new EventSource(getFileApiUrl(filePath, "watch", sourceSessionId));
    esRef.current = es;

    es.addEventListener("connected", () => {
      setWatching(true);
    });

    es.addEventListener("change", () => {
      void fetchContent(filePath, true);
    });

    es.addEventListener("error", () => {
      setWatching(false);
    });

    es.onerror = () => {
      setWatching(false);
    };

    return () => {
      loadGen.current += 1;
      es.close();
      esRef.current = null;
    };
  }, [filePath, fetchContent, sourceSessionId]);

  if (loadState.status === "loading") {
    return (
      <div
        style={{
          height: "100%",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          color: "var(--text-muted)",
          fontSize: 13,
        }}
      >
        {t("loading", "Loading…")}
      </div>
    );
  }

  if (loadState.status === "error") {
    return (
      <div
        style={{
          height: "100%",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          color: "var(--danger)",
          fontSize: 13,
        }}
      >
        {loadState.error}
      </div>
    );
  }

  const { data, prevContent, changeCount } = loadState;

  const isHtml = data.language === "html";
  const isMarkdown = data.language === "markdown";
  const lines = data.content.split("\n");
  const hasDiff = prevContent !== null && prevContent !== data.content;

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", overflow: "hidden" }}>
      {/* Status bar */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 12,
          minHeight: 40,
          padding: "4px 12px",
          borderBottom: "1px solid var(--border)",
          fontSize: 12,
          color: "var(--text-dim)",
          background: "var(--bg)",
          flexShrink: 0,
          overflowX: "auto",
          whiteSpace: "nowrap",
        }}
      >
        <span style={{ fontFamily: "var(--font-mono)" }} title={filePath}>
          {getRelativeFilePath(filePath, cwd)}
        </span>
        <span style={{ marginLeft: "auto" }}>{data.language}</span>
        {viewMode === "source" && (
          <span>{t("lineCount", "{count} lines").replace("{count}", formatNumber(lines.length, language))}</span>
        )}
        <span>{formatFileSize(data.size, language)}</span>

        {/* Live watch indicator */}
        <span
          title={watching ? t("liveSyncActive", "Live sync active") : t("notWatching", "Not watching")}
          style={{
            display: "flex",
            alignItems: "center",
            gap: 4,
            color: watching ? "var(--success)" : "var(--text-dim)",
          }}
        >
          <span
            style={{
              width: 7,
              height: 7,
              borderRadius: "50%",
              background: watching ? "var(--success)" : "var(--border)",
              display: "inline-block",
              boxShadow: watching ? "0 0 4px var(--success)" : "none",
            }}
          />
          {watching ? t("live", "live") : t("static", "static")}
        </span>

        {/* Diff / Source toggle — shown only when there are changes */}
        {hasDiff && (
          <div style={{ display: "flex", borderRadius: 5, overflow: "hidden", border: "1px solid var(--border)" }}>
            <button
              type="button"
              onClick={() => setViewMode("source")}
              style={{
                minHeight: 32,
                padding: "0 10px",
                fontSize: 12,
                border: "none",
                cursor: "pointer",
                background: viewMode === "source" ? "var(--bg-selected)" : "var(--bg-hover)",
                color: viewMode === "source" ? "var(--text)" : "var(--text-muted)",
                fontWeight: viewMode === "source" ? 600 : 400,
              }}
            >
              {t("source", "Source")}
            </button>
            <button
              type="button"
              onClick={() => setViewMode("diff")}
              style={{
                minHeight: 32,
                padding: "0 10px",
                fontSize: 12,
                border: "none",
                borderLeft: "1px solid var(--border)",
                cursor: "pointer",
                background: viewMode === "diff" ? "var(--bg-selected)" : "var(--bg-hover)",
                color: viewMode === "diff" ? "var(--text)" : "var(--text-muted)",
                fontWeight: viewMode === "diff" ? 600 : 400,
              }}
            >
              {t("diff", "Diff")}{" "}
              {changeCount > 0 && (
                <span style={{ color: "var(--success)", marginLeft: 2 }}>+{formatNumber(changeCount, language)}</span>
              )}
            </button>
          </div>
        )}

        {/* Word wrap toggle */}
        {viewMode === "source" && !previewMode && (
          <button
            type="button"
            onClick={() => setWrapLines((v) => !v)}
            title={wrapLines ? t("disableWordWrap", "Disable word wrap") : t("enableWordWrap", "Enable word wrap")}
            style={{
              minHeight: 32,
              padding: "0 10px",
              fontSize: 12,
              cursor: "pointer",
              background: wrapLines ? "var(--bg-selected)" : "var(--bg-hover)",
              color: wrapLines ? "var(--text)" : "var(--text-muted)",
              border: "1px solid var(--border)",
              borderRadius: 5,
              fontWeight: wrapLines ? 600 : 400,
            }}
          >
            {t("wrap", "wrap")}
          </button>
        )}

        {/* HTML source/preview toggle */}
        {isHtml && viewMode === "source" && (
          <div style={{ display: "flex", borderRadius: 5, overflow: "hidden", border: "1px solid var(--border)" }}>
            <button
              type="button"
              onClick={() => setPreviewMode(false)}
              style={{
                minHeight: 32,
                padding: "0 10px",
                fontSize: 12,
                border: "none",
                cursor: "pointer",
                background: !previewMode ? "var(--bg-selected)" : "var(--bg-hover)",
                color: !previewMode ? "var(--text)" : "var(--text-muted)",
                fontWeight: !previewMode ? 600 : 400,
              }}
            >
              {t("code", "Code")}
            </button>
            <button
              type="button"
              onClick={() => setPreviewMode(true)}
              style={{
                minHeight: 32,
                padding: "0 10px",
                fontSize: 12,
                border: "none",
                borderLeft: "1px solid var(--border)",
                cursor: "pointer",
                background: previewMode ? "var(--bg-selected)" : "var(--bg-hover)",
                color: previewMode ? "var(--text)" : "var(--text-muted)",
                fontWeight: previewMode ? 600 : 400,
              }}
            >
              {t("preview", "Preview")}
            </button>
          </div>
        )}

        {/* Markdown preview/raw toggle */}
        {isMarkdown && viewMode === "source" && (
          <div style={{ display: "flex", borderRadius: 5, overflow: "hidden", border: "1px solid var(--border)" }}>
            <button
              type="button"
              onClick={() => setPreviewMode(true)}
              style={{
                minHeight: 32,
                padding: "0 10px",
                fontSize: 12,
                border: "none",
                cursor: "pointer",
                background: previewMode ? "var(--bg-selected)" : "var(--bg-hover)",
                color: previewMode ? "var(--text)" : "var(--text-muted)",
                fontWeight: previewMode ? 600 : 400,
              }}
            >
              {t("preview", "Preview")}
            </button>
            <button
              type="button"
              onClick={() => setPreviewMode(false)}
              style={{
                minHeight: 32,
                padding: "0 10px",
                fontSize: 12,
                border: "none",
                borderLeft: "1px solid var(--border)",
                cursor: "pointer",
                background: !previewMode ? "var(--bg-selected)" : "var(--bg-hover)",
                color: !previewMode ? "var(--text)" : "var(--text-muted)",
                fontWeight: !previewMode ? 600 : 400,
              }}
            >
              {t("raw", "Raw")}
            </button>
          </div>
        )}
        <DownloadLink filePath={filePath} sourceSessionId={sourceSessionId} />
      </div>

      {/* Content area */}
      <div style={{ flex: 1, minHeight: 0, overflow: "auto", background: "var(--bg)" }}>
        {viewMode === "diff" && hasDiff ? (
          <DiffView oldContent={prevContent!} newContent={data.content} />
        ) : isHtml && previewMode ? (
          <HtmlPreview content={data.content} filePath={filePath} sourceSessionId={sourceSessionId} />
        ) : isMarkdown && previewMode ? (
          <div className="markdown-body markdown-file-preview" style={{ padding: "24px 32px", maxWidth: 800 }}>
            <MarkdownBody cwd={cwd} imageBasePath={getParentFilePath(filePath)} sourceSessionId={sourceSessionId}>
              {data.content}
            </MarkdownBody>
          </div>
        ) : (
          <SyntaxHighlighter
            language={data.language === "text" ? "plaintext" : data.language}
            style={isDark ? vscDarkPlus : vs}
            showLineNumbers
            lineNumberStyle={{
              color: "var(--text-dim)",
              fontStyle: "normal",
              minWidth: "3em",
              paddingRight: "1em",
            }}
            customStyle={{
              margin: 0,
              padding: "12px 0",
              background: "var(--bg)",
              fontSize: 13,
              lineHeight: 1.6,
              fontFamily: "var(--font-mono)",
              minHeight: "100%",
            }}
            codeTagProps={{ style: { fontFamily: "var(--font-mono)" } }}
            wrapLongLines={wrapLines}
          >
            {data.content}
          </SyntaxHighlighter>
        )}
      </div>
    </div>
  );
}
