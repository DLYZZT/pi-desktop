import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { ChannelBinding, ChannelsSnapshot } from "@shared/channel-types";
import { call } from "@/lib/api-client";
import {
  getQuickChannelBindingPopoverLayout,
  type QuickChannelBindingPopoverLayout,
} from "@/lib/quick-channel-binding-layout";
import { useI18n } from "@/i18n";

interface QuickChannelBindingProps {
  sessionId: string;
  snapshot: ChannelsSnapshot;
  isMobile: boolean;
  onSnapshotChange: (snapshot: ChannelsSnapshot) => void;
}

export function QuickChannelBinding({ sessionId, snapshot, isMobile, onSnapshotChange }: QuickChannelBindingProps) {
  const { t } = useI18n();
  const channelName = (channel: ChannelBinding["channel"]) => {
    if (channel === "telegram") return "Telegram";
    if (channel === "feishu") return t("feishuLark", "Feishu / Lark");
    return t("weixin", "WeChat");
  };
  const [open, setOpen] = useState(false);
  const [busyBindingId, setBusyBindingId] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [popoverLayout, setPopoverLayout] = useState<QuickChannelBindingPopoverLayout | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const dialogId = useId();

  const closePopover = useCallback((restoreFocus = false) => {
    setOpen(false);
    if (restoreFocus) {
      window.requestAnimationFrame(() => triggerRef.current?.focus());
    }
  }, []);

  const updatePopoverLayout = useCallback(() => {
    const trigger = triggerRef.current;
    if (!trigger) return;
    const next = getQuickChannelBindingPopoverLayout({
      trigger: trigger.getBoundingClientRect(),
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
      isMobile,
    });
    setPopoverLayout((previous) =>
      previous &&
      previous.left === next.left &&
      previous.top === next.top &&
      previous.width === next.width &&
      previous.maxHeight === next.maxHeight &&
      previous.placement === next.placement
        ? previous
        : next,
    );
  }, [isMobile]);

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
  const currentChannels = [...new Set(currentBindings.map((binding) => binding.channel))];

  useEffect(() => {
    setOpen(false);
    setError("");
  }, [sessionId]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: globalThis.PointerEvent) => {
      const target = event.target as Node;
      if (rootRef.current?.contains(target) || dialogRef.current?.contains(target)) return;
      closePopover();
    };
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") closePopover(true);
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [closePopover, open]);

  useLayoutEffect(() => {
    if (!open) return;
    updatePopoverLayout();

    const frame = window.requestAnimationFrame(() => dialogRef.current?.focus());
    const observer =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(() => {
            updatePopoverLayout();
          });
    if (triggerRef.current) observer?.observe(triggerRef.current);
    if (rootRef.current?.parentElement) observer?.observe(rootRef.current.parentElement);

    window.addEventListener("resize", updatePopoverLayout);
    window.addEventListener("scroll", updatePopoverLayout, true);
    return () => {
      window.cancelAnimationFrame(frame);
      observer?.disconnect();
      window.removeEventListener("resize", updatePopoverLayout);
      window.removeEventListener("scroll", updatePopoverLayout, true);
    };
  }, [open, updatePopoverLayout]);

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
  const singleChannel = currentChannels.length === 1 ? currentChannels[0] : undefined;
  const accent =
    singleChannel === "telegram"
      ? "#229ed9"
      : singleChannel === "weixin"
        ? "#07c160"
        : singleChannel === "feishu"
          ? "#3370ff"
          : "var(--accent)";
  const label = bound
    ? online
      ? singleChannel
        ? `${t("connectedToChannel", "Connected to")} ${channelName(singleChannel)}`
        : t("connectedToMessagingChannels", "Connected to messaging channels")
      : t("boundToMessagingChannelsOffline", "Bound to messaging channels (offline)")
    : t("bindMessagingConversation", "Bind messaging conversation");

  return (
    <>
      <div ref={rootRef} style={{ position: "relative", marginLeft: 10, minWidth: 0, flexShrink: 1 }}>
        <button
          ref={triggerRef}
          type="button"
          data-testid={bound ? "channel-binding-indicator" : "channel-quick-bind-button"}
          aria-haspopup="dialog"
          aria-expanded={open}
          aria-controls={open ? dialogId : undefined}
          title={`${bound ? t("channelBindingIndicatorTitle", "This UI session is shared with messaging channels") : t("bindChannelToCurrentSession", "Bind a messaging conversation to this session")}${accountNames.length > 0 ? ` · ${accountNames.join(", ")}` : ""}`}
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
            border: `1px solid ${bound ? `color-mix(in srgb, ${accent} 38%, var(--border))` : "var(--border)"}`,
            borderRadius: 999,
            background: bound ? `color-mix(in srgb, ${accent} 9%, var(--bg-panel))` : "var(--bg)",
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
              background: bound ? (online ? accent : "var(--text-dim)") : "var(--accent)",
              boxShadow: bound && online ? `0 0 0 2px color-mix(in srgb, ${accent} 18%, transparent)` : "none",
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
      </div>

      {open &&
        popoverLayout &&
        typeof document !== "undefined" &&
        createPortal(
          <div
            ref={dialogRef}
            id={dialogId}
            role="dialog"
            tabIndex={-1}
            aria-label={t("quickChannelBinding", "Quick messaging-channel binding")}
            data-testid="channel-quick-bind-popover"
            data-placement={popoverLayout.placement}
            style={{
              position: "fixed",
              top: popoverLayout.top,
              left: popoverLayout.left,
              zIndex: 250,
              width: popoverLayout.width,
              maxHeight: popoverLayout.maxHeight,
              overflowX: "hidden",
              overflowY: "auto",
              overscrollBehavior: "contain",
              border: "1px solid var(--border)",
              borderRadius: 9,
              background: "var(--bg)",
              boxShadow: "0 12px 34px rgba(0,0,0,.22)",
              padding: 12,
              outline: "none",
            }}
          >
            <div style={{ color: "var(--text)", fontSize: 13, fontWeight: 700 }}>
              {t("quickChannelBinding", "Quick messaging-channel binding")}
            </div>
            <div style={{ marginTop: 4, color: "var(--text-dim)", fontSize: 10, lineHeight: 1.5 }}>
              {t(
                "quickChannelBindingDescription",
                "Choose the messaging conversation that should share this active UI session.",
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
                    "noBindableChannelConversations",
                    "No messaging conversations are available yet. Ask an approved user to send the first message.",
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
                        border: `1px solid ${boundHere ? "color-mix(in srgb, var(--accent) 35%, var(--border))" : "var(--border)"}`,
                        borderRadius: 7,
                        background: boundHere
                          ? "color-mix(in srgb, var(--accent) 7%, var(--bg-panel))"
                          : "var(--bg-panel)",
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
                          {account?.name ?? channelName(binding.channel)} ·{" "}
                          {binding.peerKind === "group"
                            ? t("groupConversation", "Group")
                            : t("directConversation", "DM")}
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
                          <div
                            style={{
                              marginTop: 3,
                              color: boundHere ? "var(--accent)" : "var(--text-dim)",
                              fontSize: 10,
                            }}
                          >
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
          </div>,
          document.body,
        )}
    </>
  );
}
