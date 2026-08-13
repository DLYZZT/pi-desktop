import { forwardRef, useState, useEffect, useCallback, useImperativeHandle, useRef } from "react";
import { useIsMobile } from "@/hooks/useIsMobile";
import { useI18n } from "@/i18n";
import type { SkillSearchResult } from "@/lib/api-types";
import { LatestAbortableRequest } from "@/lib/latest-abortable-request";
import { CapabilityRequired, parseCapabilityIssue, type CapabilityIssue } from "@/components/CapabilityRequired";
import { formatCompactNumber } from "@/lib/locale-format";

type Translate = (key: string, fallback: string) => string;

interface Skill {
  name: string;
  description: string;
  filePath: string;
  baseDir: string;
  disableModelInvocation: boolean;
  sourceInfo: {
    source?: string;
    scope?: string;
  };
}

function shortenPath(p: string): string {
  // Match common home dir patterns: /Users/xxx, /home/xxx
  return p.replace(/^\/(?:Users|home)\/[^/]+/, "~");
}

function sourceLabel(skill: Skill): string {
  const src = skill.sourceInfo?.source;
  const scope = skill.sourceInfo?.scope;
  if (scope === "user" || src === "user") return "global";
  if (scope === "project" || src === "project") return "project";
  return "path";
}

function sourceLabelText(label: string, t: Translate): string {
  if (label === "global") return t("skillScopeGlobal", "global");
  if (label === "project") return t("skillScopeProject", "project");
  return t("skillScopePath", "path");
}

function Toggle({ enabled, loading, onToggle }: { enabled: boolean; loading: boolean; onToggle: () => void }) {
  const { t } = useI18n();
  return (
    <button
      type="button"
      role="switch"
      aria-checked={enabled}
      aria-label={
        enabled
          ? t("disableSkillInModelPrompt", "Disable skill in model prompt")
          : t("enableSkillInModelPrompt", "Enable skill in model prompt")
      }
      onClick={onToggle}
      disabled={loading}
      title={
        enabled
          ? t("visibleSkillInModelPrompt", "Visible in model prompt — click to disable")
          : t("hiddenSkillFromModelPrompt", "Hidden from model prompt — click to enable")
      }
      style={{
        flexShrink: 0,
        width: 48,
        height: 32,
        borderRadius: 16,
        border: "none",
        padding: 0,
        cursor: loading ? "wait" : "pointer",
        background: enabled ? "var(--accent)" : "var(--border)",
        position: "relative",
        transition: "background 0.18s",
        outline: "none",
      }}
    >
      <span
        style={{
          position: "absolute",
          top: 6,
          left: enabled ? 25 : 5,
          width: 20,
          height: 20,
          borderRadius: "50%",
          background: "var(--bg)",
          boxShadow: "0 1px 4px rgba(0,0,0,0.22)",
          transition: "left 0.18s cubic-bezier(.4,0,.2,1)",
        }}
      />
    </button>
  );
}

interface SkillDetailHandle {
  hasUnsavedChanges: () => boolean;
  save: () => Promise<boolean>;
}

const SkillDetail = forwardRef<
  SkillDetailHandle,
  {
    skill: Skill;
    cwd: string;
    onToggle: (skill: Skill) => void;
    toggling: boolean;
    saveError: string | null;
    onSaved: () => void;
    onDirtyChange: (dirty: boolean) => void;
  }
>(function SkillDetail({ skill, cwd, onToggle, toggling, saveError, onSaved, onDirtyChange }, ref) {
  const { t } = useI18n();
  const label = sourceLabel(skill);
  const enabled = !skill.disableModelInvocation;
  const [content, setContent] = useState("");
  const [savedContent, setSavedContent] = useState("");
  const [contentLoading, setContentLoading] = useState(true);
  const [contentSaving, setContentSaving] = useState(false);
  const [contentError, setContentError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setContentLoading(true);
    setContentError(null);
    void import("@/lib/api-client")
      .then(({ call }) => call("skills.getContent", { cwd, filePath: skill.filePath }))
      .then((result) => {
        if (cancelled) return;
        setContent(result.content);
        setSavedContent(result.content);
      })
      .catch((error) => {
        if (!cancelled)
          setContentError(requestErrorMessage(error, t("skillFileLoadFailed", "Failed to load skill file.")));
      })
      .finally(() => {
        if (!cancelled) setContentLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [cwd, skill.filePath, t]);

  const saveContent = useCallback(async (): Promise<boolean> => {
    if (content === savedContent) return true;
    setContentSaving(true);
    setContentError(null);
    try {
      const res = await fetch("/api/skills", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cwd, filePath: skill.filePath, content }),
      });
      const result = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok || result.error) {
        throw new Error(result.error ?? t("httpErrorStatus", "HTTP {status}").replace("{status}", String(res.status)));
      }
      setSavedContent(content);
      onSaved();
      return true;
    } catch (error) {
      setContentError(requestErrorMessage(error, t("skillFileSaveFailed", "Failed to save skill file.")));
      return false;
    } finally {
      setContentSaving(false);
    }
  }, [content, cwd, onSaved, savedContent, skill.filePath, t]);

  useImperativeHandle(
    ref,
    () => ({
      hasUnsavedChanges: () => content !== savedContent,
      save: saveContent,
    }),
    [content, saveContent, savedContent],
  );

  useEffect(() => {
    onDirtyChange(content !== savedContent);
    return () => onDirtyChange(false);
  }, [content, onDirtyChange, savedContent]);

  function displayPath(p: string): string {
    if (label === "project" && p.startsWith(cwd)) {
      const rel = p.slice(cwd.length).replace(/^[/\\]/, "");
      return `./${rel}`;
    }
    return shortenPath(p);
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
      {/* Path + tag + toggle */}
      <div style={{ display: "flex", alignItems: "center", gap: 7 }}>
        <span
          style={{
            fontSize: 10,
            padding: "1px 5px",
            borderRadius: 3,
            flexShrink: 0,
            background: label === "project" ? "rgba(99,102,241,0.12)" : "rgba(120,120,120,0.12)",
            color: label === "project" ? "rgba(99,102,241,0.8)" : "var(--text-dim)",
          }}
        >
          {sourceLabelText(label, t)}
        </span>
        <span
          style={{
            fontFamily: "var(--font-mono)",
            fontSize: 11,
            color: "var(--text-dim)",
            flex: 1,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {displayPath(skill.filePath)}
        </span>
        <Toggle enabled={enabled} loading={toggling} onToggle={() => onToggle(skill)} />
        {saveError && <span style={{ fontSize: 12, color: "#f87171", flexShrink: 0 }}>{saveError}</span>}
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
        <span style={{ fontSize: 12, color: "var(--text-muted)", fontWeight: 500 }}>{t("name", "Name")}</span>
        <span
          style={{
            fontFamily: "var(--font-mono)",
            fontSize: 14,
            color: "var(--text)",
          }}
        >
          {skill.name}
        </span>
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 7, minHeight: 260 }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
          <span style={{ fontSize: 12, color: "var(--text-muted)", fontWeight: 500 }}>
            {t("skillFileName", "SKILL.md")}
          </span>
          <button
            type="button"
            onClick={() => void saveContent()}
            disabled={contentLoading || contentSaving || content === savedContent}
            style={{
              minHeight: 32,
              padding: "0 11px",
              borderRadius: 5,
              border: "1px solid var(--border)",
              background: content !== savedContent ? "var(--accent)" : "var(--bg-panel)",
              color: content !== savedContent ? "#fff" : "var(--text-dim)",
              cursor: contentLoading || contentSaving || content === savedContent ? "default" : "pointer",
              fontSize: 12,
            }}
          >
            {contentSaving ? t("saving", "Saving…") : t("saveChanges", "Save changes")}
          </button>
        </div>
        {contentLoading ? (
          <div style={{ padding: 12, color: "var(--text-dim)", fontSize: 12 }}>
            {t("loadingSkillFile", "Loading skill file…")}
          </div>
        ) : (
          <textarea
            value={content}
            onChange={(event) => setContent(event.target.value)}
            disabled={contentSaving}
            spellCheck={false}
            aria-label={t("skillMarkdownContent", "Skill markdown content")}
            style={{
              width: "100%",
              flex: 1,
              minHeight: 240,
              resize: "vertical",
              border: "1px solid var(--border)",
              borderRadius: 7,
              background: "var(--bg-panel)",
              color: "var(--text)",
              padding: 12,
              fontFamily: "var(--font-mono)",
              fontSize: 12,
              lineHeight: 1.55,
              outline: "none",
            }}
          />
        )}
        {contentError && <span style={{ fontSize: 11, color: "#f87171" }}>{contentError}</span>}
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
        <span style={{ fontSize: 12, color: "var(--text-muted)", fontWeight: 500 }}>
          {t("description", "Description")}
        </span>
        <span style={{ fontSize: 14, color: "var(--text-muted)", lineHeight: 1.6 }}>{skill.description}</span>
      </div>
    </div>
  );
});

function AddSkillPanel({ cwd, onInstalled }: { cwd: string; onInstalled: () => void }) {
  const { language, t } = useI18n();
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SkillSearchResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [installing, setInstalling] = useState<string | null>(null);
  const [installError, setInstallError] = useState<string | null>(null);
  const [capabilityIssue, setCapabilityIssue] = useState<CapabilityIssue | null>(null);
  const [pendingInstallPackage, setPendingInstallPackage] = useState<string | null>(null);
  const [installedPkgs, setInstalledPkgs] = useState<Set<string>>(new Set());
  const [scope, setScope] = useState<"global" | "project">("global");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const search = useCallback(
    async (q: string) => {
      if (!q.trim()) return;
      setSearching(true);
      setSearchError(null);
      setResults([]);
      try {
        const res = await fetch("/api/skills/search", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ query: q.trim() }),
        });
        const d = (await res.json()) as {
          results?: SkillSearchResult[];
          error?: string;
        };
        if (d.error) {
          setSearchError(d.error);
          return;
        }
        setResults(d.results ?? []);
        if ((d.results ?? []).length === 0) setSearchError(t("noSkillsFound", "No skills found"));
      } catch (e) {
        setSearchError(requestErrorMessage(e, t("skillSearchFailed", "Skill search failed.")));
      } finally {
        setSearching(false);
      }
    },
    [t],
  );

  const install = useCallback(
    async (pkg: string) => {
      setInstalling(pkg);
      setInstallError(null);
      setCapabilityIssue(null);
      try {
        const res = await fetch("/api/skills/install", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ package: pkg, scope, cwd }),
        });
        const d = (await res.json()) as {
          success?: boolean;
          error?: string;
          code?: string;
          capability?: string;
        };
        if (!res.ok || d.error) {
          const issue = parseCapabilityIssue(d);
          if (issue) {
            setPendingInstallPackage(pkg);
            setCapabilityIssue(issue);
          } else {
            setInstallError(
              safeInstallError(
                d.error,
                t("httpErrorStatus", "HTTP {status}").replace("{status}", String(res.status)),
                t,
              ),
            );
          }
          return;
        }
        setPendingInstallPackage(null);
        setInstalledPkgs((prev) => new Set(prev).add(pkg));
        onInstalled();
      } catch (e) {
        setInstallError(
          safeInstallError(
            e instanceof Error ? e.message : String(e),
            t("skillInstallationFailed", "Skill installation failed."),
            t,
          ),
        );
      } finally {
        setInstalling(null);
      }
    },
    [onInstalled, scope, cwd, t],
  );

  const installPath = scope === "global" ? "~/.pi/agent/skills/" : `${shortenPath(cwd)}/.pi/agent/skills/`;

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
      {/* ── Header area ── */}
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          gap: 12,
          marginBottom: 20,
        }}
      >
        <div style={{ fontSize: 14, fontWeight: 600, color: "var(--text)" }}>{t("addSkill", "Add skill")}</div>

        {/* Search row */}
        <div style={{ display: "flex", gap: 8 }}>
          <input
            type="search"
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void search(query);
            }}
            placeholder={t("skillSearchExample", "e.g. react, testing, deploy")}
            aria-label={t("searchSkills", "Search skills")}
            style={{
              flex: 1,
              minHeight: 36,
              padding: "7px 10px",
              fontSize: 13,
              background: "var(--bg-panel)",
              border: "1px solid var(--border)",
              borderRadius: 6,
              color: "var(--text)",
              outline: "none",
            }}
          />
          <button
            type="button"
            onClick={() => search(query)}
            disabled={searching || !query.trim()}
            style={{
              minHeight: 36,
              padding: "7px 16px",
              fontSize: 13,
              borderRadius: 6,
              border: "none",
              background: "var(--accent)",
              color: "#fff",
              cursor: searching || !query.trim() ? "not-allowed" : "pointer",
              opacity: searching || !query.trim() ? 0.5 : 1,
              flexShrink: 0,
            }}
          >
            {searching ? t("searching", "Searching…") : t("search", "Search")}
          </button>
        </div>

        {/* Scope + install path row */}
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <div
            style={{
              display: "flex",
              borderRadius: 5,
              border: "1px solid var(--border)",
              overflow: "hidden",
              fontSize: 12,
              flexShrink: 0,
            }}
          >
            {(["global", "project"] as const).map((s) => (
              <button
                key={s}
                onClick={() => setScope(s)}
                style={{
                  padding: "3px 10px",
                  border: "none",
                  cursor: "pointer",
                  background: scope === s ? "var(--bg-selected)" : "none",
                  color: scope === s ? "var(--text)" : "var(--text-dim)",
                  fontWeight: scope === s ? 600 : 400,
                  borderRight: s === "global" ? "1px solid var(--border)" : "none",
                }}
              >
                {sourceLabelText(s, t)}
              </button>
            ))}
          </div>
          <span
            style={{
              fontSize: 12,
              color: "var(--text-dim)",
              fontFamily: "var(--font-mono)",
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            → {installPath}
          </span>
        </div>

        {/* Errors */}
        {searchError && <div style={{ fontSize: 12, color: "#f87171" }}>{searchError}</div>}
        {capabilityIssue && pendingInstallPackage && (
          <CapabilityRequired
            issue={capabilityIssue}
            cwd={cwd}
            onContinue={() => install(pendingInstallPackage)}
            onCancel={() => {
              setCapabilityIssue(null);
              setPendingInstallPackage(null);
            }}
          />
        )}
        {installError && <div style={{ fontSize: 12, color: "#f87171", wordBreak: "break-word" }}>{installError}</div>}
      </div>

      {/* ── Results list ── */}
      {results.length > 0 ? (
        <div style={{ flex: 1, overflowY: "auto" }}>
          {results.map((r) => {
            const isInstalled = installedPkgs.has(r.package);
            const isInstalling = installing === r.package;
            // split "owner/repo@skill" for cleaner display
            const atIdx = r.package.indexOf("@");
            const repopart = atIdx > -1 ? r.package.slice(0, atIdx) : r.package;
            const skillpart = atIdx > -1 ? r.package.slice(atIdx + 1) : null;
            return (
              <div
                key={r.package}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 14,
                  padding: "12px 0",
                  borderBottom: "1px solid var(--border)",
                }}
              >
                <div style={{ flex: 1, minWidth: 0 }}>
                  {/* skill name prominent */}
                  <div
                    style={{
                      fontSize: 13,
                      fontWeight: 600,
                      color: "var(--text)",
                      marginBottom: 3,
                    }}
                  >
                    {skillpart ?? repopart}
                  </div>
                  {/* repo + installs + link row */}
                  <div
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 10,
                      flexWrap: "wrap",
                    }}
                  >
                    <span
                      style={{
                        fontFamily: "var(--font-mono)",
                        fontSize: 11,
                        color: "var(--text-dim)",
                      }}
                    >
                      {repopart}
                    </span>
                    {r.installs > 0 && (
                      <span
                        style={{
                          fontSize: 12,
                          color: "var(--text-muted)",
                          fontWeight: 500,
                        }}
                      >
                        {t("skillInstallCount", "{count} installs").replace(
                          "{count}",
                          formatCompactNumber(r.installs, language),
                        )}
                      </span>
                    )}
                    {r.url && (
                      <a
                        href={r.url}
                        target="_blank"
                        rel="noreferrer"
                        style={{
                          fontSize: 12,
                          color: "var(--accent)",
                          textDecoration: "none",
                        }}
                      >
                        {t("skillsCatalogLink", "skills.sh ↗")}
                      </a>
                    )}
                  </div>
                </div>
                <button
                  onClick={() => !isInstalled && !isInstalling && install(r.package)}
                  disabled={isInstalled || isInstalling || installing !== null}
                  style={{
                    flexShrink: 0,
                    padding: "5px 14px",
                    fontSize: 12,
                    fontWeight: 500,
                    borderRadius: 5,
                    border: "1px solid var(--border)",
                    cursor: isInstalled || isInstalling || installing !== null ? "not-allowed" : "pointer",
                    background: isInstalled ? "rgba(34,197,94,0.1)" : "none",
                    color: isInstalled ? "#16a34a" : isInstalling ? "var(--accent)" : "var(--text-muted)",
                    transition: "color 0.12s",
                  }}
                >
                  {isInstalled
                    ? t("skillInstalled", "✓ Installed")
                    : isInstalling
                      ? t("installing", "Installing…")
                      : t("install", "Install")}
                </button>
              </div>
            );
          })}
        </div>
      ) : (
        !searchError &&
        !searching && (
          <div style={{ fontSize: 13, color: "var(--text-dim)", lineHeight: 1.8 }}>
            {t("searchSkillsCatalogPrefix", "Search")}{" "}
            <a
              href="https://skills.sh"
              target="_blank"
              rel="noreferrer"
              style={{ color: "var(--accent)", textDecoration: "none" }}
            >
              {t("skillsCatalogName", "skills.sh")}
            </a>{" "}
            {t("searchSkillsCatalogSuffix", "to discover and install skills for your agent.")}
          </div>
        )
      )}
    </div>
  );
}

function safeInstallError(message: string | undefined, fallback: string, t: Translate): string {
  if (!message) return fallback;
  if (/ENOENT|spawn\s+(?:npm|npx|node)|not found/i.test(message)) {
    return t(
      "skillDeveloperToolUnavailable",
      "A required developer tool is unavailable. Rescan tools or install JavaScript Essentials.",
    );
  }
  if (/failed to fetch|network\s*error|load failed/i.test(message)) return fallback;
  return message;
}

function requestErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof TypeError) return fallback;
  if (error instanceof Error && error.message) return error.message;
  return fallback;
}

export interface SkillsConfigHandle {
  requestLeave: (onAllowed: () => void) => void;
}

export const SkillsConfig = forwardRef<
  SkillsConfigHandle,
  {
    cwd: string;
    onClose: () => void;
    embedded?: boolean;
  }
>(function SkillsConfig({ cwd, onClose, embedded = false }, ref) {
  const isMobile = useIsMobile();
  const { t } = useI18n();
  const [skills, setSkills] = useState<Skill[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [toggling, setToggling] = useState<Set<string>>(new Set());
  const [saveError, setSaveError] = useState<string | null>(null);
  const [addMode, setAddMode] = useState(false);
  const [detailDirty, setDetailDirty] = useState(false);
  const [pendingTransition, setPendingTransition] = useState<(() => void) | null>(null);
  const [transitionSaving, setTransitionSaving] = useState(false);
  const skillsRequestRef = useRef(new LatestAbortableRequest());
  const detailRef = useRef<SkillDetailHandle>(null);

  const requestTransition = useCallback(
    (action: () => void) => {
      if (!(detailRef.current?.hasUnsavedChanges() ?? detailDirty)) {
        action();
        return;
      }
      setPendingTransition(() => action);
    },
    [detailDirty],
  );

  useImperativeHandle(ref, () => ({ requestLeave: requestTransition }), [requestTransition]);

  useEffect(() => {
    if (!detailDirty) return;
    const preventReload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", preventReload);
    return () => window.removeEventListener("beforeunload", preventReload);
  }, [detailDirty]);

  const discardAndContinue = useCallback(() => {
    const action = pendingTransition;
    setPendingTransition(null);
    setDetailDirty(false);
    action?.();
  }, [pendingTransition]);

  const saveAndContinue = useCallback(async () => {
    setTransitionSaving(true);
    const saved = (await detailRef.current?.save()) ?? false;
    setTransitionSaving(false);
    if (!saved) return;
    const action = pendingTransition;
    setPendingTransition(null);
    action?.();
  }, [pendingTransition]);

  const loadSkills = useCallback(async () => {
    const request = skillsRequestRef.current.begin();
    setLoading(true);
    setError(null);
    try {
      const response = await fetch(`/api/skills?cwd=${encodeURIComponent(cwd)}`, { signal: request.signal });
      const result = (await response.json()) as { skills?: Skill[]; error?: string };
      if (!skillsRequestRef.current.isCurrent(request.generation)) return;
      if (!response.ok || result.error) {
        throw new Error(
          result.error ?? t("httpErrorStatus", "HTTP {status}").replace("{status}", String(response.status)),
        );
      }
      const list = result.skills ?? [];
      setSkills(list);
      setSelected((current) =>
        current && list.some((skill) => skill.filePath === current) ? current : (list[0]?.filePath ?? null),
      );
    } catch (loadError) {
      if (request.signal.aborted || !skillsRequestRef.current.isCurrent(request.generation)) return;
      setError(requestErrorMessage(loadError, t("skillsLoadFailed", "Failed to load skills.")));
    } finally {
      if (skillsRequestRef.current.finish(request.generation)) setLoading(false);
    }
  }, [cwd, t]);

  useEffect(() => {
    const requests = skillsRequestRef.current;
    setSkills([]);
    setSelected(null);
    void loadSkills();
    return () => {
      requests.cancel();
    };
  }, [loadSkills]);

  const toggle = useCallback(
    async (skill: Skill) => {
      const next = !skill.disableModelInvocation;
      setToggling((s) => new Set(s).add(skill.filePath));
      setSaveError(null);
      try {
        const res = await fetch("/api/skills", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            cwd,
            filePath: skill.filePath,
            disableModelInvocation: next,
          }),
        });
        const d = (await res.json()) as { success?: boolean; error?: string };
        if (!res.ok || d.error) {
          setSaveError(d.error ?? t("httpErrorStatus", "HTTP {status}").replace("{status}", String(res.status)));
          return;
        }
        setSkills((prev) =>
          prev.map((s) => (s.filePath === skill.filePath ? { ...s, disableModelInvocation: next } : s)),
        );
      } catch (e) {
        setSaveError(requestErrorMessage(e, t("skillVisibilitySaveFailed", "Failed to update skill visibility.")));
      } finally {
        setToggling((s) => {
          const n = new Set(s);
          n.delete(skill.filePath);
          return n;
        });
      }
    },
    [cwd, t],
  );

  const selectedSkill = skills.find((s) => s.filePath === selected) ?? null;

  return (
    <div
      style={
        embedded
          ? {
              position: "relative",
              flex: 1,
              minWidth: 0,
              minHeight: 0,
              display: "flex",
            }
          : {
              position: "fixed",
              inset: 0,
              zIndex: 1000,
              background: "rgba(0,0,0,0.35)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
            }
      }
      onClick={(e) => {
        if (!embedded && e.target === e.currentTarget) requestTransition(onClose);
      }}
    >
      <div
        style={{
          width: embedded ? "100%" : isMobile ? "calc(100vw - 16px)" : 860,
          maxWidth: embedded ? undefined : "calc(100vw - 16px)",
          height: embedded ? "100%" : isMobile ? "calc(100dvh - 16px)" : "78vh",
          maxHeight: embedded ? undefined : "calc(100dvh - 16px)",
          background: "var(--bg)",
          border: embedded ? "none" : "1px solid var(--border)",
          borderRadius: embedded ? 0 : 10,
          display: "flex",
          flexDirection: "column",
          boxShadow: embedded ? "none" : "0 8px 32px rgba(0,0,0,0.18)",
          overflow: "hidden",
        }}
      >
        {/* Header */}
        {!embedded && (
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              padding: "12px 18px",
              borderBottom: "1px solid var(--border)",
              flexShrink: 0,
            }}
          >
            <div style={{ display: "flex", alignItems: "baseline", gap: 10 }}>
              <span style={{ fontSize: 15, fontWeight: 700, color: "var(--text)" }}>{t("skills", "Skills")}</span>
              <code
                style={{
                  fontSize: 11,
                  color: "var(--text-muted)",
                  fontFamily: "var(--font-mono)",
                  maxWidth: 320,
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
              >
                {shortenPath(cwd)}
              </code>
            </div>
            <button
              onClick={() => requestTransition(onClose)}
              style={{
                background: "none",
                border: "none",
                color: "var(--text-muted)",
                cursor: "pointer",
                fontSize: 20,
                lineHeight: 1,
                padding: "2px 6px",
              }}
            >
              ×
            </button>
          </div>
        )}

        {/* Body */}
        <div style={{ flex: 1, display: "flex", flexDirection: isMobile ? "column" : "row", overflow: "hidden" }}>
          {/* Left: skill list */}
          <div
            style={{
              width: isMobile ? "100%" : 210,
              maxHeight: isMobile ? "40vh" : undefined,
              borderRight: isMobile ? "none" : "1px solid var(--border)",
              borderBottom: isMobile ? "1px solid var(--border)" : "none",
              display: "flex",
              flexDirection: "column",
              flexShrink: 0,
              background: "var(--bg-panel)",
            }}
          >
            <div style={{ flex: 1, overflowY: "auto", padding: "8px 6px" }}>
              {loading ? (
                <div
                  style={{
                    padding: "10px 8px",
                    fontSize: 12,
                    color: "var(--text-muted)",
                  }}
                >
                  {t("loading", "Loading…")}
                </div>
              ) : error ? (
                <div
                  style={{
                    padding: "10px 8px",
                    fontSize: 11,
                    color: "#f87171",
                  }}
                >
                  {error}
                </div>
              ) : skills.length === 0 ? (
                <div
                  style={{
                    padding: "10px 8px",
                    fontSize: 11,
                    color: "var(--text-dim)",
                  }}
                >
                  {t("noSkillsFound", "No skills found")}
                </div>
              ) : (
                (() => {
                  const groups: { label: string; skills: typeof skills }[] = [];
                  for (const grpLabel of ["project", "global", "path"]) {
                    const grpSkills = skills.filter((s) => sourceLabel(s) === grpLabel);
                    if (grpSkills.length > 0) groups.push({ label: grpLabel, skills: grpSkills });
                  }
                  return groups.map(({ label: grpLabel, skills: grpSkills }) => (
                    <div key={grpLabel} style={{ marginBottom: 6 }}>
                      <div
                        style={{
                          padding: "4px 8px 3px",
                          fontSize: 10,
                          fontWeight: 600,
                          color: "var(--text-dim)",
                          textTransform: "uppercase",
                          letterSpacing: "0.06em",
                        }}
                      >
                        {sourceLabelText(grpLabel, t)}
                      </div>
                      {grpSkills.map((skill) => {
                        const isSelected = !addMode && selected === skill.filePath;
                        const disabled = skill.disableModelInvocation;
                        return (
                          <div
                            key={skill.filePath}
                            onClick={() => {
                              if (isSelected) return;
                              requestTransition(() => {
                                setSelected(skill.filePath);
                                setAddMode(false);
                              });
                            }}
                            style={{
                              display: "flex",
                              alignItems: "center",
                              gap: 7,
                              padding: "8px 8px",
                              borderRadius: 5,
                              cursor: "pointer",
                              background: isSelected ? "var(--bg-selected)" : "none",
                            }}
                            onMouseEnter={(e) => {
                              if (!isSelected) e.currentTarget.style.background = "var(--bg-hover)";
                            }}
                            onMouseLeave={(e) => {
                              if (!isSelected) e.currentTarget.style.background = "none";
                            }}
                          >
                            <span
                              style={{
                                flexShrink: 0,
                                width: 7,
                                height: 7,
                                borderRadius: "50%",
                                background: disabled ? "var(--border)" : "var(--accent)",
                                boxShadow: disabled ? "none" : "0 0 4px var(--accent)",
                                transition: "background 0.15s, box-shadow 0.15s",
                              }}
                            />
                            <span
                              style={{
                                fontSize: 12,
                                fontWeight: isSelected ? 600 : 400,
                                color: disabled ? "var(--text-dim)" : "var(--text)",
                                fontFamily: "var(--font-mono)",
                                flex: 1,
                                overflow: "hidden",
                                textOverflow: "ellipsis",
                                whiteSpace: "nowrap",
                              }}
                            >
                              {skill.name}
                            </span>
                          </div>
                        );
                      })}
                    </div>
                  ));
                })()
              )}
            </div>
            {/* Add skill button */}
            <div
              style={{
                padding: "8px 6px",
                borderTop: "1px solid var(--border)",
                flexShrink: 0,
              }}
            >
              <div
                onClick={() => requestTransition(() => setAddMode(true))}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 6,
                  padding: "7px 8px",
                  borderRadius: 5,
                  cursor: "pointer",
                  background: addMode ? "var(--bg-selected)" : "none",
                  color: addMode ? "var(--accent)" : "var(--text-dim)",
                  fontSize: 12,
                }}
                onMouseEnter={(e) => {
                  if (!addMode) e.currentTarget.style.background = "var(--bg-hover)";
                }}
                onMouseLeave={(e) => {
                  if (!addMode) e.currentTarget.style.background = "none";
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
                >
                  <line x1="12" y1="5" x2="12" y2="19" />
                  <line x1="5" y1="12" x2="19" y2="12" />
                </svg>
                {t("addSkill", "Add skill")}
              </div>
            </div>
          </div>

          {/* Right: detail or add panel */}
          <div style={{ flex: 1, overflowY: "auto", padding: 20 }}>
            {addMode ? (
              <AddSkillPanel
                cwd={cwd}
                onInstalled={() => {
                  void loadSkills();
                }}
              />
            ) : loading ? null : selectedSkill ? (
              <SkillDetail
                ref={detailRef}
                key={selectedSkill.filePath}
                skill={selectedSkill}
                cwd={cwd}
                onToggle={toggle}
                toggling={toggling.has(selectedSkill.filePath)}
                saveError={saveError}
                onSaved={() => void loadSkills()}
                onDirtyChange={setDetailDirty}
              />
            ) : (
              <div
                style={{
                  height: "100%",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  color: "var(--text-dim)",
                  fontSize: 13,
                }}
              >
                {t("selectSkill", "Select a skill")}
              </div>
            )}
          </div>
        </div>

        {/* Footer */}
        {!embedded && (
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "flex-end",
              padding: "10px 18px",
              borderTop: "1px solid var(--border)",
              flexShrink: 0,
            }}
          >
            <button
              onClick={() => requestTransition(onClose)}
              style={{
                padding: "6px 14px",
                background: "none",
                border: "1px solid var(--border)",
                borderRadius: 6,
                color: "var(--text-muted)",
                cursor: "pointer",
                fontSize: 13,
              }}
            >
              {t("close", "Close")}
            </button>
          </div>
        )}
      </div>
      {pendingTransition && (
        <div
          role="presentation"
          style={{
            position: "absolute",
            inset: 0,
            zIndex: 2,
            display: "grid",
            placeItems: "center",
            padding: 16,
            background: "rgba(0,0,0,0.35)",
          }}
          onClick={(event) => {
            if (event.target === event.currentTarget && !transitionSaving) setPendingTransition(null);
          }}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="unsaved-skill-title"
            onKeyDown={(event) => {
              if (event.key === "Escape" && !transitionSaving) {
                event.preventDefault();
                event.stopPropagation();
                setPendingTransition(null);
              }
            }}
            style={{
              width: 420,
              maxWidth: "100%",
              padding: 18,
              border: "1px solid var(--border)",
              borderRadius: 9,
              background: "var(--bg)",
              boxShadow: "0 16px 48px rgba(0,0,0,0.3)",
            }}
          >
            <h3 id="unsaved-skill-title" style={{ margin: 0, fontSize: 14, color: "var(--text)" }}>
              {t("unsavedSkillChanges", "Unsaved skill changes")}
            </h3>
            <p style={{ margin: "8px 0 16px", fontSize: 12, lineHeight: 1.55, color: "var(--text-muted)" }}>
              {t("unsavedSkillChangesDescription", "Save your SKILL.md changes before leaving this editor?")}
            </p>
            <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
              <button
                type="button"
                disabled={transitionSaving}
                onClick={discardAndContinue}
                style={leavePromptButtonStyle}
              >
                {t("discard", "Discard")}
              </button>
              <button
                type="button"
                disabled={transitionSaving}
                onClick={() => setPendingTransition(null)}
                style={leavePromptButtonStyle}
              >
                {t("cancel", "Cancel")}
              </button>
              <button
                type="button"
                disabled={transitionSaving}
                onClick={() => void saveAndContinue()}
                style={{
                  ...leavePromptButtonStyle,
                  borderColor: "var(--accent)",
                  background: "var(--accent)",
                  color: "#fff",
                }}
              >
                {transitionSaving ? t("saving", "Saving…") : t("save", "Save")}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
});

const leavePromptButtonStyle: React.CSSProperties = {
  minHeight: 34,
  padding: "6px 12px",
  border: "1px solid var(--border)",
  borderRadius: 6,
  background: "var(--bg-panel)",
  color: "var(--text-muted)",
  cursor: "pointer",
  fontSize: 12,
};
