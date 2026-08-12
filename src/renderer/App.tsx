import { Component, type CSSProperties, type ErrorInfo, type ReactNode, useEffect, useState } from "react";
import { AppShell } from "@/components/AppShell";
import { ensureRpc, resetRpc } from "@/lib/api-client";

class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("[pi-desktop] render error:", error, info.componentStack);
  }

  render() {
    if (this.state.error) {
      return (
        <div style={centerStyle}>
          <div style={cardStyle}>
            <h1 style={titleStyle}>UI crashed</h1>
            <p style={bodyStyle}>{this.state.error.message}</p>
            <pre style={preStyle}>{this.state.error.stack}</pre>
            <button type="button" onClick={() => window.location.reload()} style={btnPrimary}>
              Reload
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

export function App() {
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState("Connecting…");

  useEffect(() => {
    let cancelled = false;
    setStatus(window.piBridge ? "Waiting for Agent Host…" : "piBridge missing (preload failed?)");

    const connect = () => {
      ensureRpc()
        .then(() => {
          if (!cancelled) {
            setReady(true);
            setError(null);
          }
        })
        .catch((err) => {
          if (!cancelled) {
            setError(err instanceof Error ? err.message : String(err));
            setReady(false);
          }
        });
    };

    connect();

    const offRestart = window.piBridge?.onHostRestarted?.((payload) => {
      console.warn("[pi-desktop] host restarted:", payload.reason);
      resetRpc();
      setReady(false);
      setStatus("Agent Host restarted — reconnecting…");
      setError(null);
      connect();
    });

    const offCrash = window.piBridge?.onHostCrashed?.((payload) => {
      resetRpc();
      setReady(false);
      setError(payload.detail || "Agent Host crashed and could not recover");
    });

    const offMenuDiag = window.piBridge?.onMenu?.("export-diagnostics", () => {
      void window.piBridge?.exportDiagnostics?.();
    });

    // Clear dock badge when user focuses the app
    const onFocus = () => window.piBridge?.clearBadge?.();
    window.addEventListener("focus", onFocus);

    return () => {
      cancelled = true;
      offRestart?.();
      offCrash?.();
      offMenuDiag?.();
      window.removeEventListener("focus", onFocus);
    };
  }, []);

  if (error) {
    return (
      <div style={centerStyle}>
        <div style={cardStyle}>
          <h1 style={titleStyle}>Cannot connect to Agent Host</h1>
          <p style={bodyStyle}>{error}</p>
          <p style={{ ...bodyStyle, fontSize: 12 }}>
            Host must be running (utilityProcess). Check logs if this persists.
          </p>
          <button type="button" onClick={() => window.location.reload()} style={btnPrimary}>
            Retry
          </button>
          <button type="button" onClick={() => void window.piBridge?.openLogs()} style={btnSecondary}>
            Open logs
          </button>
        </div>
      </div>
    );
  }

  if (!ready) {
    return (
      <div style={centerStyle}>
        <div style={{ ...cardStyle, textAlign: "center" }}>
          <div style={{ fontSize: 13, color: "var(--text-muted)", marginBottom: 8 }}>{status}</div>
          <div style={{ fontSize: 12, color: "var(--text-dim)" }}>Pi Agent Desktop</div>
        </div>
      </div>
    );
  }

  return (
    <ErrorBoundary>
      <AppShell />
    </ErrorBoundary>
  );
}

const centerStyle: CSSProperties = {
  minHeight: "100dvh",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  padding: 32,
  background: "var(--bg)",
  color: "var(--text)",
  fontFamily: "var(--font-sans)",
};

const cardStyle: CSSProperties = {
  maxWidth: 520,
  background: "var(--bg-panel)",
  border: "1px solid var(--border)",
  borderRadius: 12,
  padding: "28px 32px",
};

const titleStyle: CSSProperties = {
  fontSize: 18,
  margin: "0 0 12px",
  fontFamily: "var(--font-mono)",
};

const bodyStyle: CSSProperties = {
  fontSize: 13.5,
  lineHeight: 1.55,
  color: "var(--text-muted)",
  margin: "0 0 8px",
};

const preStyle: CSSProperties = {
  fontSize: 11,
  overflow: "auto",
  maxHeight: 200,
  background: "var(--tool-bg)",
  color: "var(--tool-fg)",
  border: "1px solid var(--tool-border)",
  fontFamily: "var(--font-mono)",
  padding: 12,
  borderRadius: 8,
};

const btnPrimary: CSSProperties = {
  marginTop: 16,
  padding: "8px 14px",
  borderRadius: 8,
  border: "1px solid var(--border)",
  background: "var(--user-bg)",
  color: "var(--user-fg)",
  cursor: "pointer",
};

const btnSecondary: CSSProperties = {
  ...btnPrimary,
  marginLeft: 8,
  background: "var(--bg-panel)",
  color: "var(--text)",
};
