import { mcpStateLabel, mcpLoginLabel } from "@/lib/mcp-state-label";
import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from "react";
import type {
  McpConfigurationSnapshot,
  McpPanelSnapshot,
  McpScope,
  McpServerConfig,
  McpTarget,
  McpOAuthSnapshot,
  McpResourcePage,
} from "@contract/mcp";
import { call, subscribe } from "@/lib/api-client";
import { useI18n } from "@/i18n";
import { LatestRequestGate } from "@/lib/latest-request-gate";
import { McpServerEditor } from "./McpServerEditor";
import { McpToolsPanel } from "./McpToolsPanel";
import { McpServerSidebar } from "./McpServerSidebar";

export interface McpConfigHandle {
  requestLeave(action: () => void): void;
}
export const McpConfig = forwardRef<McpConfigHandle, { cwd: string | null; sessionId: string | null }>(
  function McpConfig({ cwd, sessionId }, ref) {
    const { t } = useI18n();
    const [scope, setScope] = useState<McpScope>("global"),
      [snapshot, setSnapshot] = useState<McpConfigurationSnapshot>(),
      [panel, setPanel] = useState<McpPanelSnapshot>(),
      [selected, setSelected] = useState<string>(),
      [editing, setEditing] = useState<{
        name: string;
        config: McpServerConfig;
        extension?: boolean;
        revision?: string;
      }>(),
      [dirty, setDirty] = useState(false),
      [busy, setBusy] = useState(false),
      [error, setError] = useState<string>(),
      [notice, setNotice] = useState<string>(),
      [pendingLeave, setPendingLeave] = useState<() => void>(),
      [importText, setImportText] = useState<string>(),
      [importPreview, setImportPreview] = useState<{ entries: string[]; conflicts: string[] }>(),
      [importRevision, setImportRevision] = useState<string>(),
      [probeId, setProbeId] = useState<string>(),
      [probe, setProbe] = useState<McpPanelSnapshot>(),
      [login, setLogin] = useState<McpOAuthSnapshot>(),
      [callbackUrl, setCallbackUrl] = useState(""),
      [resources, setResources] = useState<{ target: McpTarget; page: McpResourcePage }>(),
      [resourceText, setResourceText] = useState<string>(),
      [resourceRef, setResourceRef] = useState<{ hash: string; offset: number }>();
    const gate = useRef(new LatestRequestGate()).current,
      mounted = useRef(true),
      requestId = useRef<string | undefined>(undefined),
      loginId = useRef<string | undefined>(undefined);
    const viewKey = JSON.stringify([scope, cwd, sessionId]),
      view = useRef({ key: viewKey, generation: 0 });
    if (view.current.key !== viewKey) view.current = { key: viewKey, generation: view.current.generation + 1 };
    const viewGeneration = view.current.generation;
    const isCurrentView = () => mounted.current && view.current.generation === viewGeneration;
    const invoke: typeof call = async (method, ...args) => {
      const result = await call(method, ...args);
      if (!isCurrentView()) throw new Error("MCP view changed while the request was running");
      return result;
    };
    const target = (name: string): McpTarget => ({ name, scope, cwd: cwd ?? undefined });
    const load = useCallback(async () => {
      if (!mounted.current || view.current.generation !== viewGeneration) return;
      const ticket = gate.begin();
      try {
        const [config, live] = await Promise.all([
          call("mcp.config.get", { scope, cwd: cwd ?? undefined }),
          sessionId ? call("mcp.snapshot", { sessionId }) : Promise.resolve(undefined),
        ]);
        if (!gate.isCurrent(ticket) || !mounted.current) return;
        setSnapshot(config);
        setPanel(live);
        setError(config.error);
      } catch (e) {
        if (gate.isCurrent(ticket) && mounted.current) setError(e instanceof Error ? e.message : String(e));
      }
    }, [gate, scope, cwd, sessionId, viewGeneration]);
    useEffect(() => {
      mounted.current = true;
      void load();
      const timer = setInterval(() => {
        void load();
      }, 3000);
      return () => {
        mounted.current = false;
        gate.invalidate();
        clearInterval(timer);
      };
    }, [gate, load]);
    useEffect(() => {
      if (!sessionId) return;
      let disposed = false;
      const offs: (() => void)[] = [];
      for (const promise of [
        subscribe("mcp.changed", sessionId, () => {
          void load();
        }),
        subscribe("mcp.oauth", sessionId, (status) => {
          if (!disposed && status.requestId === loginId.current) setLogin(status);
        }),
      ])
        void promise
          .then((off) => {
            if (disposed) off();
            else offs.push(off);
          })
          .catch(() => undefined);
      return () => {
        disposed = true;
        offs.forEach((off) => off());
      };
    }, [sessionId, load]);
    useEffect(() => {
      setSnapshot(undefined);
      setPanel(undefined);
      setProbe(undefined);
      setProbeId(undefined);
      setLogin(undefined);
      setResources(undefined);
      setResourceText(undefined);
      setResourceRef(undefined);
      setBusy(false);
      setNotice(undefined);
      return () => {
        if (requestId.current) void call("mcp.probe.cancel", { requestId: requestId.current }).catch(() => undefined);
        if (loginId.current) void call("mcp.oauth.cancel", { requestId: loginId.current }).catch(() => undefined);
        requestId.current = undefined;
        loginId.current = undefined;
      };
    }, [scope, cwd, sessionId]);
    const leave = useCallback(
      (action: () => void) => {
        if (dirty || importText) setPendingLeave(() => action);
        else action();
      },
      [dirty, importText],
    );
    useImperativeHandle(ref, () => ({ requestLeave: leave }), [leave]);
    const run = async (operation: () => Promise<unknown>) => {
      setBusy(true);
      setError(undefined);
      setNotice(undefined);
      try {
        await operation();
        if (isCurrentView()) await load();
      } catch (e) {
        if (isCurrentView()) setError(e instanceof Error ? e.message : String(e));
      } finally {
        if (isCurrentView()) setBusy(false);
      }
    };
    const probeServer = (name: string) =>
      run(async () => {
        const id = crypto.randomUUID();
        requestId.current = id;
        setProbeId(id);
        try {
          const result = await invoke("mcp.probe", { ...target(name), requestId: id });
          if (isCurrentView()) {
            setProbe(result);
            setNotice(t("mcpProbeOnly", "This test used a temporary connection. Session status is shown separately."));
          }
        } finally {
          if (requestId.current === id) requestId.current = undefined;
          if (isCurrentView()) setProbeId(undefined);
        }
      });
    const startLogin = (name: string) =>
      run(async () => {
        const status = await call("mcp.oauth.start", target(name));
        if (!isCurrentView()) {
          await call("mcp.oauth.cancel", { requestId: status.requestId });
          return;
        }
        loginId.current = status.requestId;
        setLogin(status);
        for (;;) {
          const current = await invoke("mcp.oauth.get", { requestId: status.requestId });
          if (!isCurrentView()) return;
          setLogin(current);
          if (current.authUrl) {
            await window.piBridge?.openExternal(current.authUrl);
            break;
          }
          if (current.state !== "waiting") break;
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
      });
    useEffect(() => {
      if (!login?.requestId || login.state !== "waiting") return;
      const id = login.requestId;
      let disposed = false;
      const timer = setInterval(() => {
        void call("mcp.oauth.get", { requestId: id })
          .then((status) => {
            if (!disposed) {
              setLogin(status);
              if (status.state !== "waiting") {
                setCallbackUrl("");
                void load();
              }
            }
          })
          .catch(() => undefined);
      }, 500);
      return () => {
        disposed = true;
        clearInterval(timer);
      };
    }, [login?.requestId, login?.state, load]);
    const previewResource = (value: McpTarget, uri: string) =>
      run(async () => {
        const result = await invoke("mcp.resource.read", { ...value, uri });
        setResourceText(result.content !== undefined ? JSON.stringify(result.content, null, 2) : result.preview);
        setResourceRef(result.hash ? { hash: result.hash, offset: 0 } : undefined);
      });
    const currentLabel = panel?.adapterActive
      ? t("mcpSessionStatus", "Current session connections")
      : t("mcpAdapterInactive", "The Desktop MCP adapter is inactive or no session is open.");
    const entries = [...(snapshot?.entries ?? []), ...(panel?.extensions ?? [])];
    const selectedName = selected ?? snapshot?.entries[0]?.name ?? panel?.extensions?.[0]?.name;
    return (
      <div className="mcp-config mcp-workbench" data-mcp-config>
        <aside className="mcp-sidebar">
          <h3>{t("mcpSettings", "MCP servers")}</h3>
          <div className="mcp-scope-picker">
            <label>
              {t("mcpScope", "Scope")}{" "}
              <select
                value={scope}
                disabled={busy}
                onChange={(event) => {
                  const nextScope = event.target.value as McpScope;
                  leave(() => {
                    setScope(nextScope);
                    setSelected(undefined);
                    setEditing(undefined);
                    setDirty(false);
                    setImportText(undefined);
                  });
                }}
              >
                <option value="global">{t("mcpGlobal", "Global")}</option>
                <option value="project" disabled={!cwd}>
                  {t("mcpProject", "Current project")}
                </option>
              </select>
            </label>
          </div>
          <McpServerSidebar
            entries={entries}
            panel={panel}
            selected={selectedName}
            onSelect={(entry) =>
              leave(() => {
                setSelected(entry.name);
                setImportText(undefined);
                setEditing({
                  name: entry.name,
                  config: entry.config,
                  extension: entry.scope === "extension",
                  revision: entry.scope === "extension" ? entry.revision : snapshot?.revision,
                });
                setDirty(false);
              })
            }
          />
          <div className="mcp-sidebar-actions">
            <button
              disabled={busy}
              onClick={() =>
                leave(() => {
                  setEditing({
                    name: "",
                    config: { command: "", args: [], exposure: "codemode" },
                    revision: snapshot?.revision ?? "missing",
                  });
                  setSelected("");
                  setImportText(undefined);
                  setDirty(false);
                })
              }
            >
              {t("mcpAdd", "Add server")}
            </button>
            <button
              disabled={busy}
              onClick={() =>
                leave(() => {
                  setImportText('{\n  "mcpServers": {}\n}');
                  setImportRevision(snapshot?.revision ?? "missing");
                  setImportPreview(undefined);
                  setEditing(undefined);
                })
              }
            >
              {t("mcpImport", "Import JSON")}
            </button>
          </div>
        </aside>
        <main className="mcp-detail-pane">
          <p className="mcp-scope-description">
            {t(
              "mcpScopeHelp",
              "Project entries override global entries with the same name. A permission dialog appears when tools are first used.",
            )}
          </p>
          {scope === "project" && panel?.projectTrusted === false && (
            <p role="status">
              {t(
                "mcpProjectUntrusted",
                "This project's MCP configuration is not applied until the project is trusted.",
              )}
            </p>
          )}
          {error && (
            <p role="alert" className="mcp-error">
              {error}
            </p>
          )}
          {notice && <p role="status">{notice}</p>}
          <p>{currentLabel}</p>
          {panel?.inactiveReason === "disabled" && (
            <p>{t("mcpDisabledBySettings", "builtin:mcp is disabled in shared settings.")}</p>
          )}
          {panel?.inactiveReason === "replaced" && (
            <p>
              {t(
                "mcpReplacedByExtension",
                "Another extension manages MCP in this session. Desktop connection controls are inactive.",
              )}
            </p>
          )}
          {sessionId && !panel?.adapterActive && (
            <button
              disabled={busy}
              onClick={() => void run(() => invoke("agent.command", { sessionId, command: { type: "get_tools" } }))}
            >
              {t("mcpApplySession", "Apply MCP to this session")}
            </button>
          )}
          {snapshot?.entries
            .filter((entry) => entry.name === selectedName && editing?.name !== "" && importText === undefined)
            .map((entry) => {
              const live = panel?.instances.find((instance) => instance.name === entry.name),
                ownLive = live?.scope === scope;
              return (
                <section key={entry.name} className="mcp-server-row">
                  <div>
                    <strong>{entry.name}</strong>
                    <span className="mcp-transport-tag">{entry.config.url ? "HTTP" : "stdio"}</span>
                    {live && (
                      <span>
                        {" "}
                        · {mcpStateLabel(live.state, t)} · {live.toolCount}
                      </span>
                    )}
                    {live?.pendingApply && (
                      <span> · {t("mcpPendingApply", "Waiting for the session to become idle")}</span>
                    )}
                    {live && !ownLive && <span> · {t("mcpOverridden", "Overridden by another scope")}</span>}
                  </div>
                  <div className="mcp-actions">
                    <button
                      disabled={busy}
                      onClick={() =>
                        leave(() => {
                          setEditing({ name: entry.name, config: entry.config, revision: snapshot?.revision });
                          setDirty(false);
                        })
                      }
                    >
                      {t("mcpEdit", "Edit")}
                    </button>
                    <button
                      disabled={busy || entry.config.enabled === false}
                      onClick={() => void probeServer(entry.name)}
                    >
                      {t("mcpTest", "Test connection")}
                    </button>
                    {sessionId && ownLive && (
                      <button
                        disabled={busy || entry.config.enabled === false}
                        onClick={() => void run(() => invoke("mcp.reconnect", { sessionId, name: entry.name }))}
                      >
                        {t("mcpReconnect", "Reconnect session")}
                      </button>
                    )}
                    {entry.config.url && (
                      <button disabled={busy} onClick={() => void startLogin(entry.name)}>
                        {t("mcpSignIn", "Sign in")}
                      </button>
                    )}
                    <details className="mcp-more-actions">
                      <summary>{t("mcpMoreActions", "More actions")}</summary>
                      <div>
                        <button
                          disabled={busy || !snapshot || snapshot.revision === "invalid"}
                          onClick={() =>
                            void run(async () => {
                              await invoke("mcp.config.upsert", {
                                scope,
                                cwd: cwd ?? undefined,
                                name: entry.name,
                                config: { ...entry.config, enabled: entry.config.enabled === false },
                                expectedRevision: snapshot!.revision,
                              });
                              setNotice(t("mcpSaved", "Configuration saved."));
                            })
                          }
                        >
                          {entry.config.enabled === false ? t("mcpEnable", "Enable") : t("mcpDisable", "Disable")}
                        </button>
                        <button
                          disabled={busy}
                          onClick={() =>
                            leave(() => {
                              void run(() =>
                                invoke("mcp.config.remove", {
                                  scope,
                                  cwd: cwd ?? undefined,
                                  name: entry.name,
                                  expectedRevision: snapshot!.revision,
                                }),
                              );
                            })
                          }
                        >
                          {t("mcpRemove", "Remove")}
                        </button>
                        {entry.config.url && (
                          <>
                            <button
                              disabled={busy}
                              onClick={() => void run(() => invoke("mcp.oauth.logout", target(entry.name)))}
                            >
                              {t("mcpSignOut", "Sign out for this URL")}
                            </button>
                          </>
                        )}
                        <button
                          disabled={busy || entry.config.enabled === false}
                          onClick={() =>
                            void run(async () => {
                              const value = target(entry.name);
                              setResources({ target: value, page: await invoke("mcp.resources", value) });
                            })
                          }
                        >
                          {t("mcpResources", "Resources")}
                        </button>
                      </div>
                    </details>
                  </div>
                  {live?.error && <p className="mcp-error">{live.error}</p>}
                  {!!live?.diagnostics?.length && (
                    <details>
                      <summary>{t("mcpDiagnostics", "Connection diagnostics")}</summary>
                      <pre>{live.diagnostics.join("\n")}</pre>
                    </details>
                  )}
                </section>
              );
            })}
          {!!panel?.extensions?.length && (
            <section>
              <h4>{t("mcpExtensionServers", "Extension-registered servers")}</h4>
              {panel.extensions
                .filter((entry) => entry.name === selectedName)
                .map((entry) => (
                  <div key={entry.name} className="mcp-server-row">
                    <strong>{entry.name}</strong>
                    <p>{entry.source}</p>
                    <button
                      disabled={busy}
                      onClick={() =>
                        leave(() => {
                          setEditing({
                            name: entry.name,
                            config: entry.config,
                            extension: true,
                            revision: entry.revision,
                          });
                          setDirty(false);
                        })
                      }
                    >
                      {t("mcpEdit", "Edit")}
                    </button>
                    {sessionId && (
                      <button
                        disabled={busy}
                        onClick={() => void run(() => invoke("mcp.reconnect", { sessionId, name: entry.name }))}
                      >
                        {t("mcpReconnect", "Reconnect session")}
                      </button>
                    )}
                    <p>{t("mcpExtensionTemporary", "Changes to extension servers apply only to this session.")}</p>
                  </div>
                ))}
            </section>
          )}
          {probeId && (
            <button onClick={() => void invoke("mcp.probe.cancel", { requestId: probeId })}>
              {t("mcpCancelProbe", "Cancel connection test")}
            </button>
          )}
          {probe && (
            <details>
              <summary>{t("mcpProbeResult", "Last connection test")}</summary>
              <pre>{JSON.stringify(probe, null, 2)}</pre>
            </details>
          )}
          {editing && (
            <McpServerEditor
              initial={editing}
              busy={busy}
              onDirty={() => setDirty(true)}
              onCancel={() =>
                leave(() => {
                  setEditing(undefined);
                  setDirty(false);
                })
              }
              onSave={(name, config) =>
                void run(async () => {
                  if (editing.extension && sessionId)
                    await invoke("mcp.extension.update", {
                      sessionId,
                      name,
                      config,
                      expectedRevision: editing.revision!,
                    });
                  else
                    await invoke("mcp.config.upsert", {
                      scope,
                      cwd: cwd ?? undefined,
                      name,
                      config,
                      expectedRevision: editing.revision!,
                    });
                  setEditing(undefined);
                  setSelected(name);
                  setDirty(false);
                  setNotice(t("mcpSaved", "Configuration saved."));
                })
              }
            />
          )}
          {importText !== undefined && (
            <section>
              <label>
                {t("mcpImportJson", "Standard mcpServers JSON")}
                <textarea
                  value={importText}
                  onChange={(event) => {
                    setImportText(event.target.value);
                    setImportPreview(undefined);
                  }}
                />
              </label>
              <button
                disabled={busy}
                onClick={() =>
                  void run(async () =>
                    setImportPreview(
                      await invoke("mcp.import.preview", { scope, cwd: cwd ?? undefined, json: importText }),
                    ),
                  )
                }
              >
                {t("mcpPreviewImport", "Preview import")}
              </button>
              {importPreview && (
                <>
                  <pre>{JSON.stringify(importPreview, null, 2)}</pre>
                  <button
                    disabled={busy}
                    onClick={() =>
                      void run(async () => {
                        await invoke("mcp.import.apply", {
                          scope,
                          cwd: cwd ?? undefined,
                          json: importText,
                          expectedRevision: importRevision!,
                        });
                        setImportText(undefined);
                        setImportPreview(undefined);
                        setNotice(t("mcpSaved", "Configuration saved."));
                      })
                    }
                  >
                    {t("mcpApplyImport", "Apply import")}
                  </button>
                </>
              )}
              <button onClick={() => leave(() => setImportText(undefined))}>{t("mcpCancel", "Cancel")}</button>
            </section>
          )}
          {login && (
            <section role="status">
              <strong>{t("mcpAuthorization", "MCP authorization")}</strong> · {mcpLoginLabel(login.state, t)}
              {login.error && <p>{login.error}</p>}
              {login.state === "waiting" && (
                <>
                  <label>
                    {t("mcpCallbackUrl", "Paste callback URL")}
                    <input value={callbackUrl} onChange={(event) => setCallbackUrl(event.target.value)} />
                  </label>
                  <button
                    disabled={busy || !callbackUrl}
                    onClick={() =>
                      void run(async () => {
                        setLogin(await invoke("mcp.oauth.submit", { requestId: login.requestId, callbackUrl }));
                        setCallbackUrl("");
                      })
                    }
                  >
                    {t("mcpSubmitCallback", "Submit callback")}
                  </button>
                  <button
                    onClick={() =>
                      void run(async () => {
                        setLogin(await invoke("mcp.oauth.cancel", { requestId: login.requestId }));
                        setCallbackUrl("");
                      })
                    }
                  >
                    {t("mcpCancelLogin", "Cancel sign-in")}
                  </button>
                </>
              )}
            </section>
          )}
          {resources && (
            <section>
              <h4>{t("mcpResources", "Resources")}</h4>
              {[...resources.page.resources, ...resources.page.templates].map((resource) => (
                <div key={resource.uri}>
                  <code>{resource.uri}</code>
                  <button
                    disabled={busy || Boolean(resource.uriTemplate)}
                    onClick={() => void previewResource(resources.target, resource.uri)}
                  >
                    {t("mcpReadResource", "Read resource")}
                  </button>
                </div>
              ))}
              {(resources.page.nextCursor || resources.page.nextTemplateCursor) && (
                <button
                  disabled={busy}
                  onClick={() =>
                    void run(async () =>
                      setResources({
                        ...resources,
                        page: await invoke("mcp.resources", {
                          ...resources.target,
                          cursor: resources.page.nextCursor,
                          templateCursor: resources.page.nextTemplateCursor,
                        }),
                      }),
                    )
                  }
                >
                  {t("mcpMoreResources", "Next resource page")}
                </button>
              )}
              {resourceText && <pre>{resourceText}</pre>}
              {resourceRef && (
                <button
                  disabled={busy}
                  onClick={() =>
                    void run(async () => {
                      const chunk = await invoke("mcp.resource.content", resourceRef);
                      setResourceText(chunk.text);
                      setResourceRef(
                        chunk.nextOffset !== undefined
                          ? { hash: resourceRef.hash, offset: chunk.nextOffset }
                          : undefined,
                      );
                    })
                  }
                >
                  {t("mcpMoreContent", "Read content page")}
                </button>
              )}
            </section>
          )}
          {sessionId && importText === undefined && editing?.name !== "" && (
            <McpToolsPanel key={sessionId} sessionId={sessionId} panel={panel} server={selectedName} onChanged={load} />
          )}
          {pendingLeave && (
            <div role="alertdialog" aria-label={t("mcpUnsaved", "Unsaved MCP changes")}>
              <p>{t("mcpDiscardQuestion", "Discard the unsaved MCP edit?")}</p>
              <button
                onClick={() => {
                  const action = pendingLeave;
                  setPendingLeave(undefined);
                  setDirty(false);
                  setImportText(undefined);
                  setEditing(undefined);
                  action();
                }}
              >
                {t("mcpDiscard", "Discard changes")}
              </button>
              <button onClick={() => setPendingLeave(undefined)}>{t("mcpKeepEditing", "Keep editing")}</button>
            </div>
          )}
        </main>
      </div>
    );
  },
);
