import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { sendAgentCommand } from "@/lib/agent-client";
import { useIsMobile } from "@/hooks/useIsMobile";
import { useI18n } from "@/i18n";
import type { PluginPackageInfo, PluginsResponse } from "@/lib/api-types";
import { CapabilityRequired, parseCapabilityIssue, type CapabilityIssue } from "@/components/CapabilityRequired";
import { formatNumber } from "@/lib/locale-format";
import { pluginResourceSummary, pluginStatusLabel, pluginVersionSummary } from "@/lib/plugin-presentation";

type Translate = (key: string, fallback: string) => string;

type PluginScope = PluginPackageInfo["scope"];
type PluginAction = "install" | "remove" | "update" | "disable" | "enable";
type PendingCapabilityOperation =
  | { kind: "action"; action: PluginAction; pkg: PluginPackageInfo }
  | { kind: "install"; source: string; scope: PluginScope };

function shortenPath(path: string): string {
  return path.replace(/^\/(?:Users|home)\/[^/]+/, "~");
}

function packageKey(pkg: Pick<PluginPackageInfo, "source" | "scope">): string {
  return `${pkg.scope}\0${pkg.source}`;
}

function pluginScopeLabel(scope: PluginScope, t: Translate): string {
  return scope === "project" ? t("pluginScopeProject", "project") : t("pluginScopeGlobal", "global");
}

function installLocation(scope: PluginScope, cwd: string): string {
  return scope === "project" ? `${shortenPath(cwd)}/.pi/agent/{npm,git}` : "~/.pi/agent/{npm,git}";
}

function findInstalledPackage(
  packages: PluginPackageInfo[],
  source: string,
  scope: PluginScope,
): PluginPackageInfo | undefined {
  const trimmed = source.trim();
  const withoutNpmPrefix = trimmed.startsWith("npm:") ? trimmed.slice(4) : trimmed;
  return (
    packages.find((pkg) => pkg.scope === scope && pkg.source === trimmed) ??
    packages.find((pkg) => pkg.scope === scope && pkg.source === `npm:${withoutNpmPrefix}`) ??
    packages.find((pkg) => pkg.scope === scope && pkg.source.endsWith(trimmed))
  );
}

function statusColor(status: PluginPackageInfo["status"]): string {
  if (status === "loaded") return "var(--accent)";
  if (status === "installed") return "var(--warning)";
  if (status === "disabled") return "var(--text-dim)";
  return "var(--danger)";
}

function ResourceList({ pkg }: { pkg: PluginPackageInfo }) {
  const { t } = useI18n();
  const groups = (
    [
      ["extension", t("pluginExtensions", "Extensions")],
      ["skill", t("skills", "Skills")],
      ["prompt", t("pluginPrompts", "Prompts")],
      ["theme", t("pluginThemes", "Themes")],
    ] as const
  )
    .map(([kind, label]) => ({
      kind,
      label,
      resources: pkg.resources.filter((resource) => resource.kind === kind),
    }))
    .filter((group) => group.resources.length > 0);

  if (groups.length === 0) {
    return (
      <div style={{ fontSize: 12, color: "var(--text-dim)" }}>
        {pkg.disabled
          ? t("pluginPackageDisabled", "Package disabled")
          : t("pluginNoResolvedResources", "No resolved resources")}
      </div>
    );
  }

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 12,
      }}
    >
      {groups.map((group, groupIndex) => (
        <div
          key={group.kind}
          style={{
            borderTop: groupIndex === 0 ? "none" : "1px solid var(--border)",
            paddingTop: groupIndex === 0 ? 0 : 12,
          }}
        >
          <div
            style={{
              fontSize: 10,
              fontWeight: 700,
              color: "var(--text-dim)",
              textTransform: "uppercase",
              marginBottom: 6,
            }}
          >
            {group.label}
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {group.resources.map((resource) => (
              <div key={`${resource.kind}:${resource.path}`} style={{ minWidth: 0 }}>
                <div
                  style={{
                    fontSize: 12,
                    color: "var(--text)",
                    fontFamily: "var(--font-mono)",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                  title={resource.path}
                >
                  {resource.name}
                </div>
                <div
                  style={{
                    fontSize: 10,
                    color: "var(--text-dim)",
                    fontFamily: "var(--font-mono)",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                    marginTop: 1,
                  }}
                  title={resource.path}
                >
                  {resource.relativePath}
                </div>
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

function ScopeTag({ scope }: { scope: PluginScope }) {
  const { t } = useI18n();
  return (
    <span
      style={{
        fontSize: 10,
        padding: "1px 5px",
        borderRadius: 3,
        flexShrink: 0,
        background: scope === "project" ? "rgba(99,102,241,0.12)" : "rgba(120,120,120,0.12)",
        color: scope === "project" ? "rgba(99,102,241,0.85)" : "var(--text-dim)",
      }}
    >
      {pluginScopeLabel(scope, t)}
    </span>
  );
}

function buttonStyle(disabled?: boolean, danger?: boolean): React.CSSProperties {
  return {
    padding: "6px 12px",
    background: danger ? "rgba(239,68,68,0.08)" : "none",
    border: "1px solid var(--border)",
    borderRadius: 6,
    color: danger ? "var(--danger)" : "var(--text-muted)",
    cursor: disabled ? "not-allowed" : "pointer",
    fontSize: 12,
    opacity: disabled ? 0.5 : 1,
  };
}

function Toggle({
  enabled,
  loading,
  onToggle,
  label,
}: {
  enabled: boolean;
  loading: boolean;
  onToggle: () => void;
  label: string;
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      disabled={loading}
      title={label}
      aria-label={label}
      aria-pressed={enabled}
      style={{
        flexShrink: 0,
        width: 40,
        height: 22,
        borderRadius: 11,
        border: "none",
        padding: 0,
        cursor: loading ? "wait" : "pointer",
        background: enabled ? "var(--accent)" : "var(--border)",
        position: "relative",
        transition: "background 0.18s",
        outline: "none",
        opacity: loading ? 0.65 : 1,
      }}
    >
      <span
        style={{
          position: "absolute",
          top: 3,
          left: enabled ? 21 : 3,
          width: 16,
          height: 16,
          borderRadius: "50%",
          background: "var(--bg)",
          boxShadow: "0 1px 4px rgba(0,0,0,0.22)",
          transition: "left 0.18s cubic-bezier(.4,0,.2,1)",
        }}
      />
    </button>
  );
}

function SegmentedScope({ value, onChange }: { value: PluginScope; onChange: (scope: PluginScope) => void }) {
  const { t } = useI18n();
  return (
    <div
      style={{
        display: "inline-flex",
        border: "1px solid var(--border)",
        borderRadius: 7,
        overflow: "hidden",
        height: 30,
      }}
    >
      {(["global", "project"] as PluginScope[]).map((scope) => {
        const active = value === scope;
        return (
          <button
            key={scope}
            onClick={() => onChange(scope)}
            style={{
              width: 76,
              border: "none",
              borderRight: scope === "global" ? "1px solid var(--border)" : "none",
              background: active ? "var(--bg-selected)" : "none",
              color: active ? "var(--text)" : "var(--text-muted)",
              cursor: "pointer",
              fontSize: 12,
            }}
          >
            {pluginScopeLabel(scope, t)}
          </button>
        );
      })}
    </div>
  );
}

function AddPluginPanel({
  cwd,
  source,
  scope,
  busy,
  actionError,
  onSourceChange,
  onScopeChange,
  onInstall,
}: {
  cwd: string;
  source: string;
  scope: PluginScope;
  busy: boolean;
  actionError: string | null;
  onSourceChange: (value: string) => void;
  onScopeChange: (scope: PluginScope) => void;
  onInstall: () => void;
}) {
  const { t } = useI18n();
  const inputRef = useRef<HTMLInputElement>(null);
  const examples = ["npm:@scope/pi-plugin", "git:https://github.com/user/repo", "/absolute/path/to/plugin"];

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 18, maxWidth: 660, minHeight: "100%" }}>
      <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
        <div style={{ fontSize: 14, fontWeight: 700, color: "var(--text)" }}>{t("addPlugin", "Add plugin")}</div>
        <div style={{ fontSize: 12, color: "var(--text-dim)", fontFamily: "var(--font-mono)" }}>
          {installLocation(scope, cwd)}
        </div>
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 7 }}>
        <label htmlFor="plugin-source" style={{ fontSize: 12, fontWeight: 600, color: "var(--text-muted)" }}>
          {t("pluginSource", "Source")}
        </label>
        <input
          id="plugin-source"
          ref={inputRef}
          value={source}
          onChange={(e) => onSourceChange(e.target.value)}
          placeholder={t("pluginSourcePlaceholder", "npm:@scope/package")}
          style={{
            width: "100%",
            height: 36,
            padding: "0 11px",
            border: "1px solid var(--border)",
            borderRadius: 6,
            background: "var(--bg-panel)",
            color: "var(--text)",
            fontFamily: "var(--font-mono)",
            fontSize: 13,
            outline: "none",
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" && source.trim() && !busy) onInstall();
          }}
        />
      </div>

      <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
        <SegmentedScope value={scope} onChange={onScopeChange} />
        <button
          type="button"
          onClick={onInstall}
          disabled={busy || !source.trim()}
          style={{
            ...buttonStyle(busy || !source.trim()),
            background: "var(--accent)",
            color: "var(--on-accent)",
            borderColor: "var(--accent)",
          }}
        >
          {busy ? t("installing", "Installing…") : t("install", "Install")}
        </button>
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 7 }}>
        <div style={{ fontSize: 12, fontWeight: 600, color: "var(--text-muted)" }}>
          {t("pluginExamples", "Examples")}
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          {examples.map((example) => (
            <button
              key={example}
              type="button"
              onClick={() => onSourceChange(example)}
              style={{
                width: "100%",
                minHeight: 30,
                textAlign: "left",
                padding: "6px 9px",
                border: "1px solid var(--border)",
                borderRadius: 6,
                background: "var(--bg-panel)",
                color: "var(--text-dim)",
                cursor: "pointer",
                fontFamily: "var(--font-mono)",
                fontSize: 11,
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.background = "var(--bg-hover)";
                e.currentTarget.style.color = "var(--text-muted)";
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.background = "var(--bg-panel)";
                e.currentTarget.style.color = "var(--text-dim)";
              }}
            >
              {example}
            </button>
          ))}
        </div>
      </div>

      {actionError && <div style={{ fontSize: 12, color: "var(--danger)", whiteSpace: "pre-wrap" }}>{actionError}</div>}
    </div>
  );
}

function PackageDetail({
  pkg,
  cwd,
  busyKey,
  actionError,
  actionMessage,
  sessionId,
  onAction,
  onReloadSession,
}: {
  pkg: PluginPackageInfo;
  cwd: string;
  busyKey: string | null;
  actionError: string | null;
  actionMessage: string | null;
  sessionId: string | null;
  onAction: (action: PluginAction, pkg: PluginPackageInfo) => void;
  onReloadSession: () => void;
}) {
  const { language, t } = useI18n();
  const key = packageKey(pkg);
  const busy = busyKey?.endsWith(key) ?? false;
  const reloadBusy = busyKey === "reload";
  const enabled = !pkg.disabled;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 20, maxWidth: 680 }}>
      <div
        style={{
          display: "flex",
          alignItems: "flex-start",
          justifyContent: "space-between",
          gap: 12,
          minWidth: 0,
          flexWrap: "wrap",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 180, flex: 1 }}>
          <Toggle
            enabled={enabled}
            loading={busy || reloadBusy}
            onToggle={() => onAction(pkg.disabled ? "enable" : "disable", pkg)}
            label={
              pkg.disabled ? t("pluginEnablePackage", "Enable package") : t("pluginDisablePackage", "Disable package")
            }
          />
          <ScopeTag scope={pkg.scope} />
          {pkg.disabled ? (
            <span
              style={{
                fontSize: 10,
                padding: "1px 5px",
                borderRadius: 3,
                background: "rgba(120,120,120,0.12)",
                color: "var(--text-dim)",
              }}
            >
              {t("pluginStatusDisabled", "Disabled")}
            </span>
          ) : (
            pkg.filtered && (
              <span
                style={{
                  fontSize: 10,
                  padding: "1px 5px",
                  borderRadius: 3,
                  background: "rgba(245,158,11,0.12)",
                  color: "var(--warning)",
                }}
              >
                {t("pluginFiltered", "filtered")}
              </span>
            )
          )}
          <span
            style={{
              fontFamily: "var(--font-mono)",
              fontSize: 12,
              color: "var(--text)",
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {pkg.source}
          </span>
        </div>

        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <button
            onClick={() => onAction("update", pkg)}
            disabled={busy || reloadBusy}
            style={buttonStyle(busy || reloadBusy)}
          >
            {busyKey === `update:${key}` ? t("pluginUpdating", "Updating…") : t("pluginUpdate", "Update")}
          </button>
          <button
            onClick={onReloadSession}
            disabled={!sessionId || reloadBusy || busy}
            style={buttonStyle(!sessionId || reloadBusy || busy)}
            title={
              sessionId
                ? t("pluginReloadCurrentSession", "Reload current session")
                : t("pluginOpenSessionToReload", "Open a session to reload")
            }
          >
            {reloadBusy ? t("pluginReloading", "Reloading…") : t("pluginReloadSession", "Reload session")}
          </button>
          <button
            onClick={() => onAction("remove", pkg)}
            disabled={busy || reloadBusy}
            style={buttonStyle(busy || reloadBusy, true)}
          >
            {busyKey === `remove:${key}` ? t("pluginRemoving", "Removing…") : t("pluginRemove", "Remove")}
          </button>
        </div>
      </div>

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "minmax(96px, 130px) minmax(0, 1fr)",
          gap: "9px 14px",
          fontSize: 12,
          lineHeight: 1.45,
        }}
      >
        <div style={{ color: "var(--text-dim)" }}>{t("pluginStatus", "Status")}</div>
        <div style={{ color: statusColor(pkg.status) }}>{pluginStatusLabel(pkg.status, t)}</div>
        <div style={{ color: "var(--text-dim)" }}>{t("pluginVersion", "Version")}</div>
        <div style={{ color: "var(--text-muted)", fontFamily: "var(--font-mono)" }}>{pluginVersionSummary(pkg, t)}</div>
        <div style={{ color: "var(--text-dim)" }}>{t("pluginPackage", "Package")}</div>
        <div style={{ color: "var(--text-muted)", fontFamily: "var(--font-mono)", overflowWrap: "anywhere" }}>
          {pkg.packageName ?? t("unknown", "unknown")}
        </div>
        <div style={{ color: "var(--text-dim)" }}>{t("pluginResources", "Resources")}</div>
        <div style={{ color: "var(--text-muted)" }}>{pluginResourceSummary(pkg, language, t)}</div>
        <div style={{ color: "var(--text-dim)" }}>{t("pluginInstalledPath", "Installed path")}</div>
        <div
          style={{
            color: pkg.installedPath ? "var(--text-muted)" : "var(--danger)",
            fontFamily: "var(--font-mono)",
            overflowWrap: "anywhere",
          }}
        >
          {pkg.installedPath ? shortenPath(pkg.installedPath) : t("pluginNotFound", "Not found")}
        </div>
        <div style={{ color: "var(--text-dim)" }}>{t("pluginCwd", "Cwd")}</div>
        <div style={{ color: "var(--text-dim)", fontFamily: "var(--font-mono)", overflowWrap: "anywhere" }}>
          {shortenPath(cwd)}
        </div>
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        <div style={{ fontSize: 12, fontWeight: 700, color: "var(--text)" }}>
          {t("pluginResolvedResources", "Resolved resources")}
        </div>
        <ResourceList pkg={pkg} />
      </div>

      {actionMessage && <div style={{ fontSize: 12, color: "var(--success)" }}>{actionMessage}</div>}
      {actionError && <div style={{ fontSize: 12, color: "var(--danger)", whiteSpace: "pre-wrap" }}>{actionError}</div>}
    </div>
  );
}

export function PluginsConfig({
  cwd,
  sessionId,
  onClose,
  onReloaded,
  embedded = false,
}: {
  cwd: string;
  sessionId: string | null;
  onClose: () => void;
  onReloaded?: () => void;
  embedded?: boolean;
}) {
  const isMobile = useIsMobile();
  const { language, t } = useI18n();
  const [data, setData] = useState<PluginsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [addMode, setAddMode] = useState(false);
  const [installSource, setInstallSource] = useState("");
  const [installScope, setInstallScope] = useState<PluginScope>("global");
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionMessage, setActionMessage] = useState<string | null>(null);
  const [capabilityIssue, setCapabilityIssue] = useState<CapabilityIssue | null>(null);
  const [pendingCapabilityOperation, setPendingCapabilityOperation] = useState<PendingCapabilityOperation | null>(null);

  const packages = useMemo(() => data?.packages ?? [], [data?.packages]);
  const selectedPackage = packages.find((pkg) => packageKey(pkg) === selected) ?? null;

  const groupedPackages = useMemo(() => {
    return (["project", "global"] as PluginScope[])
      .map((scope) => ({ scope, packages: packages.filter((pkg) => pkg.scope === scope) }))
      .filter((group) => group.packages.length > 0);
  }, [packages]);

  const loadPlugins = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/plugins?cwd=${encodeURIComponent(cwd)}`);
      const next = (await res.json()) as PluginsResponse & { error?: string };
      if (!res.ok || next.error) {
        throw new Error(next.error ?? t("httpErrorStatus", "HTTP {status}").replace("{status}", String(res.status)));
      }
      setData(next);
      setAddMode((current) => next.packages.length === 0 || current);
      setSelected((current) => {
        if (current && next.packages.some((pkg) => packageKey(pkg) === current)) return current;
        return next.packages[0] ? packageKey(next.packages[0]) : null;
      });
    } catch (err) {
      setError(pluginRequestError(err, t("pluginsLoadFailed", "Failed to load plugins.")));
    } finally {
      setLoading(false);
    }
  }, [cwd, t]);

  useEffect(() => {
    void loadPlugins();
  }, [loadPlugins]);

  const runAction = useCallback(
    async (action: PluginAction, pkg: PluginPackageInfo) => {
      const key = packageKey(pkg);
      setBusyKey(`${action}:${key}`);
      setActionError(null);
      setActionMessage(null);
      setCapabilityIssue(null);
      try {
        const res = await fetch("/api/plugins", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action, source: pkg.source, scope: pkg.scope, cwd }),
        });
        const next = (await res.json()) as PluginsResponse & {
          error?: string;
          code?: string;
          capability?: string;
        };
        if (!res.ok || next.error) {
          const issue = parseCapabilityIssue(next);
          if (issue) {
            setCapabilityIssue(issue);
            setPendingCapabilityOperation({ kind: "action", action, pkg });
            return;
          }
          throw new Error(
            safePluginError(
              next.error,
              t("httpErrorStatus", "HTTP {status}").replace("{status}", String(res.status)),
              t,
            ),
          );
        }
        setPendingCapabilityOperation(null);
        setData(next);
        if (action === "remove") {
          setSelected(next.packages[0] ? packageKey(next.packages[0]) : null);
          if (next.packages.length === 0) setAddMode(true);
          setActionMessage(t("pluginPackageRemoved", "Package removed."));
        } else {
          if (action === "install") setActionMessage(t("pluginPackageInstalled", "Package installed."));
          else if (action === "update") setActionMessage(t("pluginPackageUpdated", "Package updated."));
          else if (action === "disable") {
            setActionMessage(t("pluginPackageDisabledSuccessfully", "Package disabled."));
          } else setActionMessage(t("pluginPackageEnabled", "Package enabled."));
        }
      } catch (err) {
        setActionError(
          safePluginError(
            err instanceof Error ? err.message : undefined,
            t("pluginActionFailed", "Plugin action failed."),
            t,
          ),
        );
      } finally {
        setBusyKey(null);
      }
    },
    [cwd, t],
  );

  const installPluginSource = useCallback(
    async (source: string, scope: PluginScope) => {
      const key = `${scope}\0${source}`;
      setBusyKey(`install:${key}`);
      setActionError(null);
      setActionMessage(null);
      setCapabilityIssue(null);
      try {
        const res = await fetch("/api/plugins", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "install", source, scope, cwd }),
        });
        const next = (await res.json()) as PluginsResponse & {
          error?: string;
          code?: string;
          capability?: string;
        };
        if (!res.ok || next.error) {
          const issue = parseCapabilityIssue(next);
          if (issue) {
            setCapabilityIssue(issue);
            setPendingCapabilityOperation({ kind: "install", source, scope });
            return;
          }
          throw new Error(
            safePluginError(
              next.error,
              t("httpErrorStatus", "HTTP {status}").replace("{status}", String(res.status)),
              t,
            ),
          );
        }
        setPendingCapabilityOperation(null);
        setData(next);
        const installed = findInstalledPackage(next.packages, source, scope);
        setSelected(installed ? packageKey(installed) : key);
        setAddMode(false);
        setInstallSource("");
        setActionMessage(t("pluginPackageInstalled", "Package installed."));
      } catch (err) {
        setActionError(
          safePluginError(
            err instanceof Error ? err.message : undefined,
            t("pluginInstallationFailed", "Plugin installation failed."),
            t,
          ),
        );
      } finally {
        setBusyKey(null);
      }
    },
    [cwd, t],
  );

  const installPlugin = useCallback(async () => {
    const source = installSource.trim();
    if (!source) return;
    await installPluginSource(source, installScope);
  }, [installPluginSource, installScope, installSource]);

  const retryCapabilityOperation = useCallback(async () => {
    const pending = pendingCapabilityOperation;
    if (!pending) return;
    setCapabilityIssue(null);
    if (pending.kind === "action") await runAction(pending.action, pending.pkg);
    else await installPluginSource(pending.source, pending.scope);
  }, [installPluginSource, pendingCapabilityOperation, runAction]);

  const reloadSession = useCallback(async () => {
    if (!sessionId) return;
    setBusyKey("reload");
    setActionError(null);
    setActionMessage(null);
    try {
      await sendAgentCommand(sessionId, { type: "reload" });
      onReloaded?.();
      await loadPlugins();
      setActionMessage(t("pluginSessionReloaded", "Session reloaded."));
    } catch (err) {
      setActionError(pluginRequestError(err, t("pluginSessionReloadFailed", "Failed to reload session.")));
    } finally {
      setBusyKey(null);
    }
  }, [loadPlugins, onReloaded, sessionId, t]);

  const addBusy = busyKey?.startsWith("install:") ?? false;

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
        if (!embedded && e.target === e.currentTarget) onClose();
      }}
    >
      <div
        style={{
          width: embedded ? "100%" : isMobile ? "calc(100vw - 16px)" : 860,
          maxWidth: embedded ? undefined : "calc(100vw - 16px)",
          height: embedded ? "100%" : isMobile ? "calc(100dvh - 16px)" : "76vh",
          maxHeight: embedded ? undefined : "calc(100dvh - 16px)",
          background: "var(--bg)",
          border: embedded ? "none" : "1px solid var(--border)",
          borderRadius: embedded ? 0 : 8,
          display: "flex",
          flexDirection: "column",
          boxShadow: embedded ? "none" : "0 8px 32px rgba(0,0,0,0.18)",
          overflow: "hidden",
        }}
      >
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
            <div style={{ display: "flex", alignItems: "baseline", gap: 10, minWidth: 0 }}>
              <span style={{ fontSize: 15, fontWeight: 700, color: "var(--text)" }}>{t("plugins", "Plugins")}</span>
              <code
                style={{
                  fontSize: 11,
                  color: "var(--text-muted)",
                  fontFamily: "var(--font-mono)",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
              >
                {shortenPath(cwd)}
              </code>
            </div>
            <button
              onClick={onClose}
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

        <div style={{ flex: 1, display: "flex", flexDirection: isMobile ? "column" : "row", overflow: "hidden" }}>
          <div
            style={{
              width: isMobile ? "100%" : 245,
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
                <div style={{ padding: "10px 8px", fontSize: 12, color: "var(--text-muted)" }}>
                  {t("loading", "Loading…")}
                </div>
              ) : error ? (
                <div style={{ padding: "10px 8px", fontSize: 11, color: "var(--danger)" }}>{error}</div>
              ) : packages.length === 0 ? (
                <div style={{ padding: "10px 8px", fontSize: 11, color: "var(--text-dim)" }}>
                  {t("pluginNoPackagesConfigured", "No plugins configured")}
                </div>
              ) : (
                groupedPackages.map((group) => (
                  <div key={group.scope} style={{ marginBottom: 6 }}>
                    <div
                      style={{
                        padding: "4px 8px 3px",
                        fontSize: 10,
                        fontWeight: 600,
                        color: "var(--text-dim)",
                        textTransform: "uppercase",
                      }}
                    >
                      {pluginScopeLabel(group.scope, t)}
                    </div>
                    {group.packages.map((pkg) => {
                      const key = packageKey(pkg);
                      const isSelected = !addMode && selected === key;
                      return (
                        <div
                          key={key}
                          onClick={() => {
                            setSelected(key);
                            setAddMode(false);
                            setActionError(null);
                            setActionMessage(null);
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
                              background: statusColor(pkg.status),
                            }}
                          />
                          <div style={{ minWidth: 0, flex: 1 }}>
                            <div
                              style={{
                                fontSize: 12,
                                fontWeight: isSelected ? 600 : 400,
                                color: "var(--text)",
                                fontFamily: "var(--font-mono)",
                                overflow: "hidden",
                                textOverflow: "ellipsis",
                                whiteSpace: "nowrap",
                              }}
                            >
                              {pkg.source}
                            </div>
                            <div
                              style={{
                                fontSize: 10,
                                color: "var(--text-dim)",
                                overflow: "hidden",
                                textOverflow: "ellipsis",
                                whiteSpace: "nowrap",
                                marginTop: 2,
                              }}
                            >
                              {pluginResourceSummary(pkg, language, t)}
                            </div>
                            {(pkg.version || pkg.configuredVersion) && (
                              <div
                                style={{
                                  fontSize: 10,
                                  color: "var(--text-dim)",
                                  overflow: "hidden",
                                  textOverflow: "ellipsis",
                                  whiteSpace: "nowrap",
                                  marginTop: 2,
                                }}
                              >
                                {pluginVersionSummary(pkg, t)}
                              </div>
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                ))
              )}
            </div>
            <div style={{ padding: "8px 6px", borderTop: "1px solid var(--border)", flexShrink: 0 }}>
              <button
                type="button"
                onClick={() => {
                  setAddMode(true);
                  setActionError(null);
                  setActionMessage(null);
                }}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 6,
                  padding: "7px 8px",
                  borderRadius: 5,
                  border: "none",
                  width: "100%",
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
                {t("addPlugin", "Add plugin")}
              </button>
            </div>
          </div>

          <div style={{ flex: 1, overflowY: "auto", padding: 20 }}>
            {capabilityIssue && pendingCapabilityOperation && (
              <div style={{ marginBottom: 14 }}>
                <CapabilityRequired
                  issue={capabilityIssue}
                  cwd={cwd}
                  onContinue={retryCapabilityOperation}
                  onCancel={() => {
                    setCapabilityIssue(null);
                    setPendingCapabilityOperation(null);
                  }}
                />
              </div>
            )}
            {addMode ? (
              <AddPluginPanel
                cwd={cwd}
                source={installSource}
                scope={installScope}
                busy={addBusy}
                actionError={actionError}
                onSourceChange={setInstallSource}
                onScopeChange={setInstallScope}
                onInstall={installPlugin}
              />
            ) : loading ? null : selectedPackage ? (
              <PackageDetail
                key={packageKey(selectedPackage)}
                pkg={selectedPackage}
                cwd={cwd}
                busyKey={busyKey}
                actionError={actionError}
                actionMessage={actionMessage}
                sessionId={sessionId}
                onAction={runAction}
                onReloadSession={reloadSession}
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
                {t("selectPackage", "Select a package")}
              </div>
            )}
          </div>
        </div>

        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 12,
            padding: "10px 18px",
            borderTop: "1px solid var(--border)",
            flexShrink: 0,
          }}
        >
          <div style={{ minWidth: 0, flex: 1, fontSize: 11, color: "var(--text-dim)", overflow: "hidden" }}>
            {data?.diagnostics.length ? (
              <span
                title={data.diagnostics
                  .map((d) => `${d.type}: ${d.source ? `${d.source}: ` : ""}${d.message}`)
                  .join("\n")}
                style={{ color: data.diagnostics.some((d) => d.type === "error") ? "var(--danger)" : "var(--warning)" }}
              >
                {t("pluginDiagnosticCount", "{count} diagnostics").replace(
                  "{count}",
                  formatNumber(data.diagnostics.length, language),
                )}
              </span>
            ) : (
              <span>
                {data
                  ? [
                      t("pluginExtensionCount", "{count} ext").replace(
                        "{count}",
                        formatNumber(data.totals.extensions, language),
                      ),
                      t("pluginSkillCount", "{count} skills").replace(
                        "{count}",
                        formatNumber(data.totals.skills, language),
                      ),
                      t("pluginPromptCount", "{count} prompts").replace(
                        "{count}",
                        formatNumber(data.totals.prompts, language),
                      ),
                      t("pluginThemeCount", "{count} themes").replace(
                        "{count}",
                        formatNumber(data.totals.themes, language),
                      ),
                    ].join(" · ")
                  : ""}
              </span>
            )}
          </div>
          <button
            onClick={() => void loadPlugins()}
            disabled={loading || busyKey !== null}
            style={buttonStyle(loading || busyKey !== null)}
          >
            {t("refresh", "Refresh")}
          </button>
          {!embedded && (
            <button onClick={onClose} style={buttonStyle(false)}>
              {t("close", "Close")}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function safePluginError(message: string | undefined, fallback: string, t: Translate): string {
  if (!message) return fallback;
  if (/ENOENT|spawn\s+(?:npm|npx|node|git)|not found/i.test(message)) {
    return t(
      "pluginDeveloperToolUnavailable",
      "A required developer tool is unavailable. Rescan tools or install the matching Essentials profile.",
    );
  }
  if (/failed to fetch|network\s*error|load failed/i.test(message)) return fallback;
  return message;
}

function pluginRequestError(error: unknown, fallback: string): string {
  if (error instanceof TypeError) return fallback;
  if (error instanceof Error && error.message) return error.message;
  return fallback;
}
