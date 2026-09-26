import { useState, useCallback, useEffect, useRef } from "react";
import { getFileIcon, FolderIcon } from "./FileIcons";
import { getRelativeFilePath } from "@/lib/file-paths";
import { useDirectoryListing, useFileExplorer } from "@/hooks/useFileExplorer";
import type { FileNode } from "@/lib/file-explorer-data";
import { useI18n } from "@/i18n";
import { formatNumber } from "@/lib/locale-format";

interface Props {
  cwd: string;
  onOpenFile: (filePath: string, fileName: string) => void;
  refreshKey?: number;
  onAtMention?: (relativePath: string, isDir: boolean) => void;
}

function TreeNode({
  node,
  depth,
  cwd,
  onOpenFile,
  onAtMention,
  expandedPaths,
  onToggleExpanded,
  refreshKey,
}: {
  node: FileNode;
  depth: number;
  cwd: string;
  onOpenFile: (filePath: string, fileName: string) => void;
  onAtMention?: (relativePath: string, isDir: boolean) => void;
  expandedPaths: Set<string>;
  onToggleExpanded: (fullPath: string, open: boolean) => void;
  refreshKey?: number;
}) {
  const { t } = useI18n();
  const open = expandedPaths.has(node.fullPath);
  const {
    entries: children,
    loaded,
    stale,
    loading,
  } = useDirectoryListing({ path: node.fullPath, directory: node.isDir, open, revision: refreshKey, t });
  const [hovered, setHovered] = useState(false);
  const [focusedWithin, setFocusedWithin] = useState(false);
  const [downloading, setDownloading] = useState(false);

  const handleClick = useCallback(() => {
    if (node.isDir) {
      const next = !open;
      onToggleExpanded(node.fullPath, next);
    } else {
      onOpenFile(node.fullPath, node.name);
    }
  }, [node.isDir, node.fullPath, node.name, open, onOpenFile, onToggleExpanded]);

  return (
    <div>
      <div
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        onFocus={() => setFocusedWithin(true)}
        onBlur={(event) => {
          const next = event.relatedTarget as Node | null;
          if (!next || !event.currentTarget.contains(next)) setFocusedWithin(false);
        }}
        style={{
          position: "relative",
          margin: "1px 0",
        }}
      >
        <button
          type="button"
          onClick={handleClick}
          aria-expanded={node.isDir ? open : undefined}
          aria-label={
            node.isDir
              ? open
                ? t("collapseFolder", "Collapse folder {name}").replace("{name}", node.name)
                : t("expandFolder", "Expand folder {name}").replace("{name}", node.name)
              : t("openFile", "Open file {name}").replace("{name}", node.name)
          }
          title={node.fullPath}
          style={{
            display: "flex",
            alignItems: "center",
            gap: 4,
            width: "100%",
            paddingLeft: 8 + depth * 14,
            paddingRight: (hovered || focusedWithin) && onAtMention ? (node.isDir ? 88 : 122) : 8,
            height: 40,
            cursor: "pointer",
            background: hovered || focusedWithin ? "var(--bg-hover)" : "transparent",
            border: "none",
            borderRadius: 6,
            userSelect: "none",
            textAlign: "left",
            transition: "background 0.12s, padding-right 0.12s",
          }}
        >
          {node.isDir && (
            <svg
              width="10"
              height="10"
              viewBox="0 0 10 10"
              fill="none"
              stroke="var(--text-dim)"
              strokeWidth="1.8"
              strokeLinecap="round"
              strokeLinejoin="round"
              style={{ flexShrink: 0, transform: open ? "rotate(90deg)" : "none", transition: "transform 0.1s" }}
            >
              <polyline points="3 2 7 5 3 8" />
            </svg>
          )}
          {!node.isDir && <span style={{ width: 10, flexShrink: 0 }} />}
          <span style={{ flexShrink: 0, display: "flex", alignItems: "center" }}>
            {node.isDir ? <FolderIcon size={14} open={open} /> : getFileIcon(node.name, 14)}
          </span>
          <span
            style={{
              fontSize: 13,
              color: "var(--text)",
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
              flex: 1,
            }}
          >
            {node.name}
          </span>
          {loading && (
            <svg
              width="10"
              height="10"
              viewBox="0 0 24 24"
              fill="none"
              stroke="var(--text-dim)"
              strokeWidth="2"
              strokeLinecap="round"
            >
              <path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4" />
            </svg>
          )}
        </button>
        {onAtMention && (hovered || focusedWithin) && (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onAtMention(getRelativeFilePath(node.fullPath, cwd), node.isDir);
            }}
            title={t("insertPathIntoChat", "Insert path into chat")}
            style={{
              position: "absolute",
              right: !node.isDir ? 40 : 4,
              top: "50%",
              transform: "translateY(-50%)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              gap: 4,
              padding: "0 8px",
              height: 30,
              background: "var(--bg-panel)",
              border: "1px solid var(--border)",
              borderRadius: 4,
              color: "var(--accent)",
              cursor: "pointer",
              fontSize: 12,
              fontWeight: 600,
              whiteSpace: "nowrap",
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
            >
              <circle cx="12" cy="12" r="4" />
              <path d="M16 8v5a3 3 0 0 0 6 0v-1a10 10 0 1 0-4 8" />
            </svg>
            {t("mention", "mention")}
          </button>
        )}
        {(hovered || focusedWithin) && !node.isDir && (
          <button
            type="button"
            disabled={downloading}
            onClick={(e) => {
              e.stopPropagation();
              setDownloading(true);
              void import("@/lib/file-blob")
                .then(({ downloadFileViaRpc }) => downloadFileViaRpc(node.fullPath, node.name))
                .catch((error) => console.error("download failed", error))
                .finally(() => setDownloading(false));
            }}
            title={t("downloadFile", "Download file")}
            style={{
              position: "absolute",
              right: 4,
              top: "50%",
              transform: "translateY(-50%)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              gap: 4,
              padding: "0 5px",
              width: 30,
              height: 30,
              background: "var(--bg-panel)",
              border: "1px solid var(--border)",
              borderRadius: 4,
              color: "var(--text-muted)",
              cursor: downloading ? "wait" : "pointer",
              fontSize: 12,
              fontWeight: 600,
              whiteSpace: "nowrap",
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
            >
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
              <polyline points="7 10 12 15 17 10" />
              <line x1="12" y1="15" x2="12" y2="3" />
            </svg>
          </button>
        )}
      </div>
      {node.isDir && open && (
        <div>
          {children.map((child) => (
            <TreeNode
              key={child.fullPath}
              node={child}
              depth={depth + 1}
              cwd={cwd}
              onOpenFile={onOpenFile}
              onAtMention={onAtMention}
              expandedPaths={expandedPaths}
              onToggleExpanded={onToggleExpanded}
              refreshKey={refreshKey}
            />
          ))}
          {children.length === 0 && loaded && !stale && (
            <div
              style={{
                paddingLeft: 8 + (depth + 1) * 14,
                fontSize: 12,
                color: "var(--text-dim)",
                height: 32,
                display: "flex",
                alignItems: "center",
              }}
            >
              {t("empty", "empty")}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export function FileExplorer({ cwd, onOpenFile, refreshKey, onAtMention }: Props) {
  const { language, t } = useI18n();
  const { entries: roots, gitStatus, watching, loading, loaded, error, revision } = useFileExplorer(cwd, refreshKey, t);
  const [expandedPaths, setExpandedPaths] = useState<Set<string>>(new Set());
  const previousCwd = useRef(cwd);
  const handleToggleExpanded = useCallback((fullPath: string, open: boolean) => {
    setExpandedPaths((previous) => {
      const next = new Set(previous);
      if (open) next.add(fullPath);
      else next.delete(fullPath);
      return next;
    });
  }, []);
  useEffect(() => {
    if (previousCwd.current === cwd) return;
    previousCwd.current = cwd;
    setExpandedPaths(new Set());
  }, [cwd]);

  if (!loaded && loading) {
    return (
      <div style={{ padding: "8px 12px", fontSize: 11, color: "var(--text-dim)" }}>
        {t("loadingFiles", "Loading files…")}
      </div>
    );
  }

  if (error) {
    return <div style={{ padding: "8px 12px", fontSize: 11, color: "#f87171" }}>{error}</div>;
  }

  return (
    <div style={{ padding: "2px 4px" }}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 7,
          padding: "5px 8px 7px",
          fontSize: 10.5,
          color: "var(--text-dim)",
          borderBottom: "1px solid var(--border)",
          marginBottom: 3,
        }}
      >
        <span
          title={
            watching
              ? t("projectChangesMonitored", "Project changes are monitored")
              : t("projectWatcherUnavailable", "Project watcher unavailable")
          }
          style={{
            width: 7,
            height: 7,
            borderRadius: "50%",
            background: watching ? "var(--success)" : "var(--border)",
            flexShrink: 0,
          }}
        />
        {gitStatus?.isGit ? (
          <>
            <span
              style={{
                fontFamily: "var(--font-mono)",
                color: "var(--text-muted)",
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
            >
              {gitStatus.branch ?? "detached"}
            </span>
            {gitStatus.clean ? (
              <span style={{ color: "var(--success)" }}>{t("gitClean", "clean")}</span>
            ) : (
              <span
                title={t("changedPathCount", "{count} changed paths").replace(
                  "{count}",
                  formatNumber(gitStatus.entries.length, language),
                )}
              >
                {gitStatus.staged
                  ? t("gitStagedCount", "+{count} staged ").replace("{count}", formatNumber(gitStatus.staged, language))
                  : ""}
                {gitStatus.modified
                  ? t("gitModifiedCount", "{count} modified ").replace(
                      "{count}",
                      formatNumber(gitStatus.modified, language),
                    )
                  : ""}
                {gitStatus.untracked
                  ? t("gitUntrackedCount", "{count} untracked ").replace(
                      "{count}",
                      formatNumber(gitStatus.untracked, language),
                    )
                  : ""}
                {gitStatus.conflicted
                  ? t("gitConflictedCount", "{count} conflicted").replace(
                      "{count}",
                      formatNumber(gitStatus.conflicted, language),
                    )
                  : ""}
              </span>
            )}
          </>
        ) : (
          <span>{watching ? t("live", "live") : t("static", "static")}</span>
        )}
      </div>
      {roots.map((node) => (
        <TreeNode
          key={node.fullPath}
          node={node}
          depth={0}
          cwd={cwd}
          onOpenFile={onOpenFile}
          onAtMention={onAtMention}
          expandedPaths={expandedPaths}
          onToggleExpanded={handleToggleExpanded}
          refreshKey={revision}
        />
      ))}
      {roots.length === 0 && (
        <div style={{ padding: "8px 12px", fontSize: 11, color: "var(--text-dim)" }}>
          {t("noFilesFound", "No files found")}
        </div>
      )}
    </div>
  );
}
