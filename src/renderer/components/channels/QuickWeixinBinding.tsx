import { useEffect, useMemo, useRef, useState } from "react";
import type { ChannelBinding, ChannelsSnapshot } from "@shared/channel-types";
import { call } from "@/lib/api-client";
import { useI18n } from "@/i18n";

interface QuickWeixinBindingProps {
  sessionId: string;
  snapshot: ChannelsSnapshot;
  isMobile: boolean;
  onSnapshotChange: (snapshot: ChannelsSnapshot) => void;
}

export function QuickWeixinBinding({ sessionId, snapshot, isMobile, onSnapshotChange }: QuickWeixinBindingProps) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [busyBindingId, setBusyBindingId] = useState<string | null>(null);
  const [error, setError] = useState("");
  const rootRef = useRef<HTMLDivElement | null>(null);

  const currentBindings = useMemo(
    () => snapshot.bindings.filter((binding) => binding.sessionId === sessionId),
    [sessionId, snapshot.bindings],
  );
  const accountNames = useMemo(
    () => [
      ...new Set(
        currentBindings.flatMap((binding) => {
          const account = snapshot.accounts.find((candidate) => candidate.id === binding.accountId);
          return account ? [account.name] : [];
        }),
      ),
    ],
    [currentBindings, snapshot.accounts],
  );
  const online = currentBindings.some((binding) =>
    snapshot.statuses.some((status) => status.accountId === binding.accountId && status.connected),
  );
  const available = snapshot.accounts.some((account) => account.configured) || snapshot.bindings.length > 0;

  useEffect(() => {
    setOpen(false);
    setError("");
  }, [sessionId]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: globalThis.PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  if (!available) return null;

  const updateBinding = async (binding: ChannelBinding, bind: boolean) => {
    setBusyBindingId(binding.id);
    setError("");
    try {
      const next = await call("channels.bindingUpsert", {
        binding: {
          ...binding,
          sessionId: bind ? sessionId : undefined,
          lastUsedAt: new Date().toISOString(),
        },
      });
      onSnapshotChange(next);
      setOpen(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusyBindingId(null);
    }
  };

  const bound = currentBindings.length > 0;
  const label = bound
    ? online
      ? t("connectedToWeixin", "Connected to WeChat")
      : t("boundToWeixinOffline", "Bound to WeChat (offline)")
    : t("bindWeixin", "Bind WeChat");

  return (
    <div ref={rootRef} style={{ position: "relative", marginLeft: 10, minWidth: 0, flexShrink: 1 }}>
      <button
        type="button"
        data-testid={bound ? "channel-binding-indicator" : "channel-quick-bind-button"}
        aria-haspopup="dialog"
        aria-expanded={open}
        title={`${bound ? t("channelBindingIndicatorTitle", "This UI session is shared with WeChat") : t("bindWeixinToCurrentSession", "Bind a WeChat conversation to this session")}${accountNames.length > 0 ? ` · ${accountNames.join(", ")}` : ""}`}
        onClick={() => {
          setError("");
          setOpen((value) => !value);
        }}
        style={{
          minWidth: 0,
          maxWidth: isMobile ? 148 : 280,
          padding: "5px 9px",
          display: "flex",
          alignItems: "center",
          gap: 6,
          border: `1px solid ${bound ? "color-mix(in srgb, #07c160 38%, var(--border))" : "var(--border)"}`,
          borderRadius: 999,
          background: bound ? "color-mix(in srgb, #07c160 9%, var(--bg-panel))" : "var(--bg)",
          color: "var(--text-muted)",
          fontSize: 11,
          whiteSpace: "nowrap",
          cursor: "pointer",
          overflow: "hidden",
        }}
      >
        <span
          aria-hidden="true"
          style={{
            width: 7,
            height: 7,
            flexShrink: 0,
            borderRadius: "50%",
            background: bound ? (online ? "#07c160" : "var(--text-dim)") : "#07c160",
            boxShadow: bound && online ? "0 0 0 2px #07c16022" : "none",
          }}
        />
        <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis" }}>
          {label}
          {!isMobile && currentBindings.length > 1
            ? ` · ${currentBindings.length} ${t("conversations", "conversations")}`
            : ""}
        </span>
        <span aria-hidden="true" style={{ fontSize: 9, opacity: 0.7 }}>
          ▾
        </span>
      </button>

      {open && (
        <div
          role="dialog"
          aria-label={t("quickWeixinBinding", "Quick WeChat binding")}
          data-testid="channel-quick-bind-popover"
          style={{
            position: "absolute",
            top: "calc(100% + 8px)",
            left: isMobile ? -70 : 0,
            zIndex: 30,
            width: isMobile ? "min(340px, calc(100vw - 24px))" : 370,
            maxHeight: "min(440px, calc(100dvh - 76px))",
            overflow: "auto",
            border: "1px solid var(--border)",
            borderRadius: 9,
            background: "var(--bg)",
            boxShadow: "0 12px 34px rgba(0,0,0,.22)",
            padding: 12,
          }}
        >
          <div style={{ color: "var(--text)", fontSize: 13, fontWeight: 700 }}>
            {t("quickWeixinBinding", "Quick WeChat binding")}
          </div>
          <div style={{ marginTop: 4, color: "var(--text-dim)", fontSize: 10, lineHeight: 1.5 }}>
            {t(
              "quickWeixinBindingDescription",
              "Choose the WeChat conversation that should share this active UI session.",
            )}
          </div>

          {error && (
            <div style={{ marginTop: 9, color: "#ef4444", fontSize: 11, overflowWrap: "anywhere" }}>{error}</div>
          )}

          <div style={{ display: "grid", gap: 8, marginTop: 11 }}>
            {snapshot.bindings.length === 0 ? (
              <div
                style={{
                  border: "1px dashed var(--border)",
                  borderRadius: 7,
                  padding: 12,
                  color: "var(--text-dim)",
                  fontSize: 11,
                  lineHeight: 1.6,
                }}
              >
                {t(
                  "noBindableWeixinConversations",
                  "No WeChat conversations are available yet. Ask an approved user to send the first message.",
                )}
              </div>
            ) : (
              snapshot.bindings.map((binding) => {
                const account = snapshot.accounts.find((candidate) => candidate.id === binding.accountId);
                const boundHere = binding.sessionId === sessionId;
                const boundElsewhere = Boolean(binding.sessionId) && !boundHere;
                const busy = busyBindingId === binding.id;
                return (
                  <div
                    key={binding.id}
                    style={{
                      display: "grid",
                      gridTemplateColumns: "minmax(0,1fr) auto",
                      alignItems: "center",
                      gap: 10,
                      border: `1px solid ${boundHere ? "#07c16055" : "var(--border)"}`,
                      borderRadius: 7,
                      background: boundHere ? "#07c1600d" : "var(--bg-panel)",
                      padding: "9px 10px",
                    }}
                  >
                    <div style={{ minWidth: 0 }}>
                      <div
                        style={{
                          color: "var(--text)",
                          fontSize: 11,
                          fontWeight: 650,
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          whiteSpace: "nowrap",
                        }}
                      >
                        {account?.name ?? t("weixinAccount", "WeChat account")} ·{" "}
                        {binding.peerKind === "group" ? t("groupConversation", "Group") : t("directConversation", "DM")}
                      </div>
                      <div
                        title={binding.peerId}
                        style={{
                          marginTop: 3,
                          color: "var(--text-dim)",
                          fontFamily: "var(--font-mono)",
                          fontSize: 10,
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          whiteSpace: "nowrap",
                        }}
                      >
                        {binding.peerId}
                      </div>
                      {(boundHere || boundElsewhere) && (
                        <div style={{ marginTop: 3, color: boundHere ? "#07a651" : "var(--text-dim)", fontSize: 10 }}>
                          {boundHere
                            ? t("boundToCurrentSession", "Bound to current session")
                            : t("boundToAnotherSession", "Bound to another session")}
                        </div>
                      )}
                    </div>
                    <button
                      type="button"
                      disabled={busyBindingId !== null}
                      onClick={() => void updateBinding(binding, !boundHere)}
                      style={{
                        border: `1px solid ${boundHere ? "#ef444466" : "var(--accent)"}`,
                        borderRadius: 6,
                        background: boundHere ? "var(--bg)" : "var(--accent)",
                        color: boundHere ? "#ef4444" : "white",
                        padding: "6px 9px",
                        fontSize: 10,
                        whiteSpace: "nowrap",
                        cursor: busyBindingId !== null ? "default" : "pointer",
                        opacity: busyBindingId !== null && !busy ? 0.55 : 1,
                      }}
                    >
                      {busy
                        ? t("saving", "Saving…")
                        : boundHere
                          ? t("unbind", "Unbind")
                          : boundElsewhere
                            ? t("rebindHere", "Rebind here")
                            : t("bindHere", "Bind here")}
                    </button>
                  </div>
                );
              })
            )}
          </div>
        </div>
      )}
    </div>
  );
}
