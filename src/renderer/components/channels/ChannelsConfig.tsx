import { QRCodeSVG } from "@rc-component/qrcode";
import { useCallback, useEffect, useMemo, useState } from "react";
import type {
  ChannelAccountConfig,
  ChannelAccountView,
  ChannelBinding,
  ChannelLoginEvent,
  ChannelProbeResult,
  ChannelStatus,
  ChannelsSnapshot,
} from "@shared/channel-types";
import type { SessionInfo } from "@contract/types";
import { call, listSessions, subscribe } from "@/lib/api-client";
import { useI18n } from "@/i18n";

const EMPTY: ChannelsSnapshot = { accounts: [], statuses: [], pairings: [], bindings: [], activities: [] };
const TOOL_PRESETS = {
  none: [],
  read: ["read", "grep", "find", "ls"],
  full: ["read", "bash", "edit", "write", "grep", "find", "ls"],
} as const;

function buttonStyle(primary = false): React.CSSProperties {
  return {
    border: `1px solid ${primary ? "var(--accent)" : "var(--border)"}`,
    borderRadius: 6,
    background: primary ? "var(--accent)" : "var(--bg)",
    color: primary ? "white" : "var(--text-muted)",
    fontSize: 12,
    padding: "7px 11px",
    cursor: "pointer",
  };
}

const inputStyle: React.CSSProperties = {
  width: "100%",
  border: "1px solid var(--border)",
  borderRadius: 6,
  background: "var(--bg)",
  color: "var(--text)",
  fontSize: 12,
  padding: "8px 9px",
};

function statusFor(snapshot: ChannelsSnapshot, accountId: string): ChannelStatus | undefined {
  return snapshot.statuses.find((status) => status.accountId === accountId);
}

function statusColor(status?: ChannelStatus): string {
  if (status?.state === "running") return "#22c55e";
  if (status?.state === "starting" || status?.state === "reconnecting") return "#f59e0b";
  if (status?.state === "error") return "#ef4444";
  return "var(--text-dim)";
}

export function ChannelsConfig({ onSnapshotChange }: { onSnapshotChange?: (snapshot: ChannelsSnapshot) => void }) {
  const { t } = useI18n();
  const [snapshot, setSnapshot] = useState<ChannelsSnapshot>(EMPTY);
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [login, setLogin] = useState<ChannelLoginEvent | null>(null);
  const [verificationCode, setVerificationCode] = useState("");

  const refresh = useCallback(async () => {
    try {
      const [channels, sessionResult] = await Promise.all([call("channels.list"), listSessions()]);
      setSnapshot(channels);
      onSnapshotChange?.(channels);
      setSessions(sessionResult.sessions);
      setError("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoading(false);
    }
  }, [onSnapshotChange]);

  useEffect(() => {
    void refresh();
    const unsubs: Array<() => void> = [];
    void Promise.all([
      subscribe("channels.status", "*", () => void refresh()),
      subscribe("channels.pairing", "*", () => void refresh()),
      subscribe("channels.binding", "*", () => void refresh()),
      subscribe("channels.activity", "*", () => void refresh()),
      subscribe("channels.login", "*", (event) => setLogin(event)),
    ]).then((items) => unsubs.push(...items));
    return () => unsubs.forEach((unsubscribe) => unsubscribe());
  }, [refresh]);

  useEffect(() => {
    if (
      !login ||
      ["confirmed", "already_connected", "expired", "error", "cancelled", "verification_required"].includes(login.phase)
    ) {
      return;
    }
    let cancelled = false;
    const timer = setTimeout(() => {
      void call("channels.loginWait", { channel: "weixin", sessionKey: login.sessionKey })
        .then((event) => {
          if (!cancelled) {
            setLogin(event);
            if (event.phase === "confirmed") void refresh();
          }
        })
        .catch((cause) => {
          if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause));
        });
    }, 600);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [login, refresh]);

  const run = useCallback(
    async (task: () => Promise<unknown>) => {
      setBusy(true);
      setError("");
      try {
        await task();
        await refresh();
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        setBusy(false);
      }
    },
    [refresh],
  );

  const beginLogin = () =>
    run(async () => {
      const event = await call("channels.loginStart", { channel: "weixin", force: true });
      setLogin(event);
    });

  const closeLogin = () => {
    if (login && !["confirmed", "already_connected", "expired", "error", "cancelled"].includes(login.phase)) {
      void call("channels.loginCancel", { channel: "weixin", sessionKey: login.sessionKey });
    }
    setLogin(null);
    setVerificationCode("");
  };

  const configuredCount = snapshot.accounts.filter((account) => account.configured).length;

  return (
    <div style={{ width: "100%", overflowY: "auto", padding: "22px clamp(16px, 4vw, 36px)" }}>
      <div style={{ maxWidth: 820, margin: "0 auto" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 16 }}>
          <div>
            <h2 style={{ margin: 0, color: "var(--text)", fontSize: 16 }}>{t("channels", "Messaging channels")}</h2>
            <p style={{ margin: "6px 0 0", color: "var(--text-dim)", fontSize: 12, lineHeight: 1.6 }}>
              {t("channelsDescription", "Connect IM accounts, control access, and bind conversations to Pi sessions.")}
            </p>
          </div>
          <button type="button" disabled={busy} style={buttonStyle(true)} onClick={beginLogin}>
            {t("connectWeixin", "Connect WeChat")}
          </button>
        </div>

        {error && (
          <div
            style={{
              marginTop: 14,
              border: "1px solid #ef444466",
              background: "#ef444414",
              color: "#ef4444",
              borderRadius: 7,
              padding: 10,
              fontSize: 12,
            }}
          >
            {error}
          </div>
        )}

        <section style={{ marginTop: 20 }}>
          <div
            style={{
              fontSize: 11,
              color: "var(--text-dim)",
              textTransform: "uppercase",
              letterSpacing: ".08em",
              marginBottom: 8,
            }}
          >
            {t("channelOverview", "Overview")} · {configuredCount} {t("configuredAccounts", "accounts configured")}
          </div>
          {loading ? (
            <div style={{ color: "var(--text-dim)", fontSize: 12 }}>{t("loading", "Loading…")}</div>
          ) : snapshot.accounts.length === 0 ? (
            <div
              style={{
                border: "1px dashed var(--border)",
                borderRadius: 9,
                padding: 28,
                textAlign: "center",
                color: "var(--text-dim)",
                fontSize: 12,
              }}
            >
              {t("noChannels", "No messaging accounts configured. Connect WeChat to get started.")}
            </div>
          ) : (
            <div style={{ display: "grid", gap: 12 }}>
              {snapshot.accounts.map((account) => (
                <AccountCard
                  key={account.id}
                  account={account}
                  status={statusFor(snapshot, account.id)}
                  busy={busy}
                  onSave={(next) => run(() => call("channels.accountUpsert", { account: next }))}
                  onStart={() => run(() => call("channels.start", { accountId: account.id }))}
                  onStop={() => run(() => call("channels.stop", { accountId: account.id }))}
                  onRestart={() => run(() => call("channels.restart", { accountId: account.id }))}
                  onProbe={() => call("channels.probe", { accountId: account.id })}
                  onTestSend={(peerId, message) =>
                    run(() => call("channels.testSend", { accountId: account.id, peerId, message }))
                  }
                  onDelete={() => {
                    if (window.confirm(t("deleteChannelConfirm", "Delete this messaging account and its bindings?"))) {
                      void run(() => call("channels.accountDelete", { accountId: account.id }));
                    }
                  }}
                />
              ))}
            </div>
          )}
        </section>

        <PairingSection snapshot={snapshot} busy={busy} run={run} />
        <BindingsSection snapshot={snapshot} sessions={sessions} busy={busy} run={run} />
        <ActivitySection snapshot={snapshot} />
      </div>

      {login && (
        <LoginDialog
          event={login}
          code={verificationCode}
          setCode={setVerificationCode}
          onSubmitCode={() =>
            run(async () => {
              await call("channels.loginSubmitCode", {
                channel: "weixin",
                sessionKey: login.sessionKey,
                code: verificationCode,
              });
              setVerificationCode("");
              setLogin({ ...login, phase: "waiting", message: "正在验证…" });
            })
          }
          onClose={closeLogin}
        />
      )}
    </div>
  );
}

function AccountCard({
  account,
  status,
  busy,
  onSave,
  onStart,
  onStop,
  onRestart,
  onProbe,
  onTestSend,
  onDelete,
}: {
  account: ChannelAccountView;
  status?: ChannelStatus;
  busy: boolean;
  onSave: (account: ChannelAccountConfig) => void;
  onStart: () => void;
  onStop: () => void;
  onRestart: () => void;
  onProbe: () => Promise<ChannelProbeResult>;
  onTestSend: (peerId: string, message: string) => void;
  onDelete: () => void;
}) {
  const { language, t } = useI18n();
  const [draft, setDraft] = useState<ChannelAccountConfig>(account);
  const [testPeer, setTestPeer] = useState("");
  const [testMessage, setTestMessage] = useState(() => t("channelTestMessage", "Pi Agent Desktop channel test"));
  const [probing, setProbing] = useState(false);
  const [probeFeedback, setProbeFeedback] = useState<{ ok: boolean; message: string; at: number } | null>(null);
  useEffect(() => setDraft(account), [account]);
  useEffect(() => {
    if (!probeFeedback) return;
    const timer = setTimeout(() => setProbeFeedback(null), 8_000);
    return () => clearTimeout(timer);
  }, [probeFeedback]);
  const preset = useMemo(() => {
    const value = [...draft.toolNames].sort().join(",");
    if (value === [...TOOL_PRESETS.read].sort().join(",")) return "read";
    if (value === [...TOOL_PRESETS.full].sort().join(",")) return "full";
    return "none";
  }, [draft.toolNames]);

  const handleProbe = async () => {
    setProbing(true);
    setProbeFeedback(null);
    try {
      const result = await onProbe();
      setProbeFeedback({
        ok: result.ok,
        message: result.ok ? t("connectionHealthy", "Connection is healthy") : result.message,
        at: Date.now(),
      });
    } catch (cause) {
      setProbeFeedback({
        ok: false,
        message: cause instanceof Error ? cause.message : String(cause),
        at: Date.now(),
      });
    } finally {
      setProbing(false);
    }
  };

  return (
    <div style={{ border: "1px solid var(--border)", borderRadius: 9, background: "var(--bg-panel)", padding: 15 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 9 }}>
          <div
            style={{
              width: 34,
              height: 34,
              borderRadius: 9,
              display: "grid",
              placeItems: "center",
              background: "#07c1601a",
              color: "#07a651",
              fontWeight: 800,
            }}
          >
            微
          </div>
          <div>
            <div style={{ color: "var(--text)", fontSize: 13, fontWeight: 700 }}>{account.name}</div>
            <div style={{ color: statusColor(status), fontSize: 11, marginTop: 2 }}>
              {t(`channelStatus_${status?.state ?? "stopped"}`, status?.state ?? "stopped")} ·{" "}
              {account.credentialFingerprint ?? t("notConfigured", "not configured")}
            </div>
          </div>
        </div>
        <label style={{ fontSize: 11, color: "var(--text-muted)", display: "flex", alignItems: "center", gap: 6 }}>
          <input
            type="checkbox"
            checked={draft.enabled}
            onChange={(event) => setDraft({ ...draft, enabled: event.target.checked })}
          />{" "}
          {t("enabled", "Enabled")}
        </label>
      </div>

      {status?.lastError && <div style={{ color: "#ef4444", fontSize: 11, marginTop: 10 }}>{status.lastError}</div>}

      <div
        style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(190px,1fr))", gap: 10, marginTop: 14 }}
      >
        <Field label={t("channelName", "Name")}>
          <input
            style={inputStyle}
            value={draft.name}
            onChange={(event) => setDraft({ ...draft, name: event.target.value })}
          />
        </Field>
        <Field label={t("dmAccess", "Direct-message access")}>
          <select
            style={inputStyle}
            value={draft.dmPolicy}
            onChange={(event) =>
              setDraft({ ...draft, dmPolicy: event.target.value as ChannelAccountConfig["dmPolicy"] })
            }
          >
            <option value="pairing">{t("policyPairing", "Pairing")}</option>
            <option value="allowlist">{t("policyAllowlistOnly", "Allowlist only")}</option>
            <option value="open">{t("policyOpenUnsafe", "Open (unsafe)")}</option>
          </select>
        </Field>
        <Field label={t("allowedUserIds", "Allowed user IDs")}>
          <input
            style={inputStyle}
            value={draft.allowFrom.join(", ")}
            onChange={(event) =>
              setDraft({
                ...draft,
                allowFrom: event.target.value
                  .split(",")
                  .map((item) => item.trim())
                  .filter(Boolean),
              })
            }
          />
        </Field>
        <Field label={t("groupAccess", "Group access")}>
          <select
            style={inputStyle}
            value={draft.groupPolicy}
            onChange={(event) =>
              setDraft({ ...draft, groupPolicy: event.target.value as ChannelAccountConfig["groupPolicy"] })
            }
          >
            <option value="disabled">{t("policyDisabledRecommended", "Disabled (recommended)")}</option>
            <option value="allowlist">{t("policyAllowlist", "Allowlist")}</option>
            <option value="open">{t("policyOpenUnsafe", "Open (unsafe)")}</option>
          </select>
        </Field>
        <Field label={t("allowedGroupSenderIds", "Allowed group sender IDs")}>
          <input
            style={inputStyle}
            value={draft.groupAllowFrom.join(", ")}
            onChange={(event) =>
              setDraft({
                ...draft,
                groupAllowFrom: event.target.value
                  .split(",")
                  .map((item) => item.trim())
                  .filter(Boolean),
              })
            }
          />
        </Field>
        <Field label={t("groupMentionRequired", "Group mention required")}>
          <label style={{ display: "flex", alignItems: "center", gap: 7, minHeight: 34, color: "var(--text-muted)" }}>
            <input
              type="checkbox"
              checked={draft.requireMention}
              onChange={(event) => setDraft({ ...draft, requireMention: event.target.checked })}
            />
            {t("requireMention", "Require @mention")}
          </label>
        </Field>
        <Field label={t("defaultTools", "Default tools")}>
          <select
            style={inputStyle}
            value={preset}
            onChange={(event) =>
              setDraft({ ...draft, toolNames: [...TOOL_PRESETS[event.target.value as keyof typeof TOOL_PRESETS]] })
            }
          >
            <option value="none">{t("toolPresetNone", "No tools (recommended)")}</option>
            <option value="read">{t("toolPresetRead", "Read-only tools")}</option>
            <option value="full">{t("toolPresetFull", "Full coding tools")}</option>
          </select>
        </Field>
        <Field label={t("defaultProjectDirectory", "Default project directory")}>
          <div style={{ display: "flex", gap: 6 }}>
            <input
              style={inputStyle}
              readOnly
              value={draft.defaultCwd ?? t("isolatedChannelWorkspace", "Isolated channel workspace")}
            />
            <button
              type="button"
              style={buttonStyle()}
              onClick={() =>
                void window.piBridge.selectDirectory().then((cwd) => cwd && setDraft({ ...draft, defaultCwd: cwd }))
              }
            >
              {t("browse", "Browse")}
            </button>
          </div>
        </Field>
      </div>

      <div style={{ display: "flex", flexWrap: "wrap", gap: 7, marginTop: 13 }}>
        <button
          type="button"
          disabled={busy}
          style={buttonStyle(true)}
          onClick={() => {
            const elevated =
              draft.dmPolicy === "open" ||
              draft.groupPolicy === "open" ||
              draft.toolNames.includes("bash") ||
              draft.toolNames.includes("write");
            if (
              elevated &&
              !window.confirm(
                t(
                  "elevatedChannelConfirm",
                  "This configuration allows remote messages to reach powerful local capabilities. Confirm that the account and allowed users are trusted.",
                ),
              )
            ) {
              return;
            }
            onSave(draft);
          }}
        >
          {t("save", "Save")}
        </button>
        {status?.state === "running" ? (
          <button type="button" disabled={busy} style={buttonStyle()} onClick={onStop}>
            {t("stop", "Stop")}
          </button>
        ) : (
          <button type="button" disabled={busy || !draft.enabled} style={buttonStyle()} onClick={onStart}>
            {t("start", "Start")}
          </button>
        )}
        <button type="button" disabled={busy} style={buttonStyle()} onClick={onRestart}>
          {t("restart", "Restart")}
        </button>
        <button
          type="button"
          disabled={busy || probing}
          style={{ ...buttonStyle(), opacity: probing ? 0.65 : 1 }}
          onClick={() => void handleProbe()}
        >
          {probing ? t("testingConnection", "Testing…") : t("testConnection", "Test connection")}
        </button>
        <button type="button" disabled={busy} style={{ ...buttonStyle(), color: "#ef4444" }} onClick={onDelete}>
          {t("delete", "Delete")}
        </button>
      </div>

      {probeFeedback && (
        <div
          role="status"
          data-testid="channel-probe-feedback"
          style={{
            marginTop: 9,
            padding: "7px 9px",
            border: `1px solid ${probeFeedback.ok ? "#22c55e55" : "#ef444455"}`,
            borderRadius: 6,
            background: probeFeedback.ok ? "#22c55e12" : "#ef444412",
            color: probeFeedback.ok ? "#16a34a" : "#ef4444",
            fontSize: 11,
          }}
        >
          {probeFeedback.ok ? "✓" : "!"} {probeFeedback.message} ·{" "}
          {new Date(probeFeedback.at).toLocaleTimeString(language)}
        </div>
      )}

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "minmax(150px,1fr) minmax(220px,2fr) auto",
          gap: 7,
          marginTop: 12,
        }}
      >
        <input
          style={inputStyle}
          value={testPeer}
          onChange={(event) => setTestPeer(event.target.value)}
          placeholder={t("testSendUserId", "User ID for test-send")}
        />
        <input style={inputStyle} value={testMessage} onChange={(event) => setTestMessage(event.target.value)} />
        <button
          type="button"
          disabled={busy || !testPeer.trim() || !testMessage.trim()}
          style={buttonStyle()}
          onClick={() => onTestSend(testPeer.trim(), testMessage.trim())}
        >
          {t("testSend", "Test send")}
        </button>
      </div>
    </div>
  );
}

function PairingSection({
  snapshot,
  busy,
  run,
}: {
  snapshot: ChannelsSnapshot;
  busy: boolean;
  run: (task: () => Promise<unknown>) => Promise<void>;
}) {
  const { language, t } = useI18n();
  return (
    <Section title={`${t("pairingRequests", "Pairing requests")} (${snapshot.pairings.length})`}>
      {snapshot.pairings.length === 0 ? (
        <EmptyLine>{t("noPairingRequests", "No pending requests.")}</EmptyLine>
      ) : (
        snapshot.pairings.map((pairing) => (
          <div
            key={pairing.id}
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              gap: 10,
              padding: "9px 0",
              borderBottom: "1px solid var(--border)",
            }}
          >
            <div style={{ fontSize: 12, color: "var(--text-muted)" }}>
              <div>{pairing.peerId}</div>
              <div style={{ color: "var(--text-dim)", marginTop: 3 }}>
                {t("pairingCode", "Code")} {pairing.code} · {t("expiresAt", "expires")}{" "}
                {new Date(pairing.expiresAt).toLocaleTimeString(language)}
              </div>
            </div>
            <div style={{ display: "flex", gap: 6 }}>
              <button
                disabled={busy}
                style={buttonStyle(true)}
                onClick={() => void run(() => call("channels.pairingApprove", { pairingId: pairing.id }))}
              >
                {t("approve", "Approve")}
              </button>
              <button
                disabled={busy}
                style={buttonStyle()}
                onClick={() => void run(() => call("channels.pairingReject", { pairingId: pairing.id }))}
              >
                {t("reject", "Reject")}
              </button>
            </div>
          </div>
        ))
      )}
    </Section>
  );
}

function BindingsSection({
  snapshot,
  sessions,
  busy,
  run,
}: {
  snapshot: ChannelsSnapshot;
  sessions: SessionInfo[];
  busy: boolean;
  run: (task: () => Promise<unknown>) => Promise<void>;
}) {
  const { t } = useI18n();
  return (
    <Section title={`${t("conversationBindings", "Conversation bindings")} (${snapshot.bindings.length})`}>
      {snapshot.bindings.length === 0 ? (
        <EmptyLine>
          {t("noConversationBindings", "A binding is created after an approved user sends the first message.")}
        </EmptyLine>
      ) : (
        snapshot.bindings.map((binding) => (
          <BindingRow key={binding.id} binding={binding} sessions={sessions} busy={busy} run={run} />
        ))
      )}
    </Section>
  );
}

function BindingRow({
  binding,
  sessions,
  busy,
  run,
}: {
  binding: ChannelBinding;
  sessions: SessionInfo[];
  busy: boolean;
  run: (task: () => Promise<unknown>) => Promise<void>;
}) {
  const { t } = useI18n();
  const [sessionId, setSessionId] = useState(binding.sessionId ?? "");
  useEffect(() => setSessionId(binding.sessionId ?? ""), [binding.sessionId]);
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "minmax(150px,1fr) minmax(220px,2fr) auto",
        alignItems: "center",
        gap: 8,
        padding: "9px 0",
        borderBottom: "1px solid var(--border)",
      }}
    >
      <div style={{ fontSize: 11, color: "var(--text-muted)", overflow: "hidden", textOverflow: "ellipsis" }}>
        {binding.peerId}
      </div>
      <select style={inputStyle} value={sessionId} onChange={(event) => setSessionId(event.target.value)}>
        <option value="">{t("dedicatedImSession", "Dedicated IM session")}</option>
        {sessions.map((session) => (
          <option key={session.id} value={session.id}>
            {session.name || session.firstMessage || session.id}
          </option>
        ))}
      </select>
      <div style={{ display: "flex", gap: 5 }}>
        <button
          disabled={busy}
          style={buttonStyle()}
          onClick={() =>
            void run(() =>
              call("channels.bindingUpsert", {
                binding: { ...binding, sessionId: sessionId || undefined, lastUsedAt: new Date().toISOString() },
              }),
            )
          }
        >
          {t("save", "Save")}
        </button>
        <button
          disabled={busy}
          style={{ ...buttonStyle(), color: "#ef4444" }}
          onClick={() => void run(() => call("channels.bindingDelete", { bindingId: binding.id }))}
          title={t("deleteBinding", "Delete binding")}
          aria-label={t("deleteBinding", "Delete binding")}
        >
          ×
        </button>
      </div>
    </div>
  );
}

function ActivitySection({ snapshot }: { snapshot: ChannelsSnapshot }) {
  const { language, t } = useI18n();
  const [expanded, setExpanded] = useState(false);
  const [showAll, setShowAll] = useState(false);
  const visibleActivities = showAll ? snapshot.activities : snapshot.activities.slice(0, 12);
  return (
    <section
      style={{
        marginTop: 22,
        border: "1px solid var(--border)",
        borderRadius: 9,
        background: "var(--bg-panel)",
        padding: "4px 15px",
      }}
    >
      <button
        type="button"
        data-testid="channel-activity-toggle"
        aria-expanded={expanded}
        onClick={() => setExpanded((value) => !value)}
        style={{
          width: "100%",
          minHeight: 50,
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 12,
          padding: 0,
          border: 0,
          background: "none",
          color: "var(--text)",
          cursor: "pointer",
          textAlign: "left",
        }}
      >
        <span>
          <span style={{ display: "block", fontSize: 12, fontWeight: 700 }}>
            {t("recentActivity", "Recent activity")} ({snapshot.activities.length})
          </span>
          <span style={{ display: "block", marginTop: 3, fontSize: 10, color: "var(--text-dim)" }}>
            {t("recentActivityDescription", "Message content is never logged; the latest 100 records are retained.")}
          </span>
        </span>
        <span
          aria-hidden="true"
          style={{
            color: "var(--text-dim)",
            fontSize: 15,
            transform: expanded ? "rotate(180deg)" : "none",
            transition: "transform .15s ease",
          }}
        >
          ▾
        </span>
      </button>

      {expanded && (
        <div style={{ borderTop: "1px solid var(--border)", paddingBottom: 8 }}>
          {snapshot.activities.length === 0 ? (
            <EmptyLine>{t("noChannelActivity", "No channel activity yet.")}</EmptyLine>
          ) : (
            visibleActivities.map((activity) => (
              <div
                key={activity.id}
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  gap: 10,
                  padding: "7px 0",
                  borderBottom: "1px solid var(--border)",
                  fontSize: 11,
                }}
              >
                <span style={{ color: activity.outcome === "failed" ? "#ef4444" : "var(--text-muted)" }}>
                  {t(`activityDirection_${activity.direction}`, activity.direction)} ·{" "}
                  {t(`activityOutcome_${activity.outcome}`, activity.outcome)}
                  {activity.detail ? ` · ${activity.detail}` : ""}
                </span>
                <span style={{ color: "var(--text-dim)", whiteSpace: "nowrap" }}>
                  {new Date(activity.at).toLocaleString(language)}
                </span>
              </div>
            ))
          )}
          {snapshot.activities.length > 12 && (
            <button
              type="button"
              style={{ ...buttonStyle(), marginTop: 9 }}
              onClick={() => setShowAll((value) => !value)}
            >
              {showAll
                ? t("showLatestTwelve", "Show latest 12")
                : `${t("showAllActivity", "Show all")} (${snapshot.activities.length})`}
            </button>
          )}
        </div>
      )}
    </section>
  );
}

function LoginDialog({
  event,
  code,
  setCode,
  onSubmitCode,
  onClose,
}: {
  event: ChannelLoginEvent;
  code: string;
  setCode: (value: string) => void;
  onSubmitCode: () => void;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const terminal = ["confirmed", "already_connected", "expired", "error", "cancelled"].includes(event.phase);
  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 1200,
        background: "rgba(0,0,0,.45)",
        display: "grid",
        placeItems: "center",
      }}
    >
      <div
        style={{
          width: 390,
          maxWidth: "calc(100vw - 28px)",
          border: "1px solid var(--border)",
          borderRadius: 10,
          background: "var(--bg)",
          padding: 22,
          textAlign: "center",
          boxShadow: "0 14px 45px rgba(0,0,0,.25)",
        }}
      >
        <h3 style={{ margin: 0, color: "var(--text)", fontSize: 16 }}>{t("connectWeixin", "Connect WeChat")}</h3>
        {event.qrContent && !terminal && (
          <div
            style={{
              width: 236,
              height: 236,
              padding: 10,
              background: "white",
              borderRadius: 8,
              margin: "18px auto 12px",
            }}
          >
            <QRCodeSVG
              value={event.qrContent}
              size={216}
              level="M"
              marginSize={2}
              title={t("weixinLoginQrCode", "WeChat login QR code")}
            />
          </div>
        )}
        <p style={{ color: event.phase === "error" ? "#ef4444" : "var(--text-muted)", fontSize: 12, lineHeight: 1.6 }}>
          {event.message}
        </p>
        {event.phase === "verification_required" && (
          <div style={{ display: "flex", gap: 7, marginTop: 12 }}>
            <input
              autoFocus
              style={inputStyle}
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
              placeholder={t("verificationNumber", "Verification number")}
            />
            <button type="button" style={buttonStyle(true)} onClick={onSubmitCode}>
              {t("submit", "Submit")}
            </button>
          </div>
        )}
        {(event.phase === "waiting" || event.phase === "scanned") && (
          <div style={{ color: "var(--text-dim)", fontSize: 11 }}>{t("pollingSecurely", "Polling securely…")}</div>
        )}
        <button type="button" style={{ ...buttonStyle(), marginTop: 16 }} onClick={onClose}>
          {terminal ? t("close", "Close") : t("cancel", "Cancel")}
        </button>
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label style={{ display: "grid", gap: 5, color: "var(--text-dim)", fontSize: 11 }}>
      {label}
      {children}
    </label>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section
      style={{
        marginTop: 22,
        border: "1px solid var(--border)",
        borderRadius: 9,
        background: "var(--bg-panel)",
        padding: "13px 15px",
      }}
    >
      <div style={{ fontSize: 12, fontWeight: 700, color: "var(--text)", marginBottom: 5 }}>{title}</div>
      {children}
    </section>
  );
}

function EmptyLine({ children }: { children: React.ReactNode }) {
  return <div style={{ color: "var(--text-dim)", fontSize: 11, padding: "9px 0" }}>{children}</div>;
}
