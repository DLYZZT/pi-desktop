import {
  Component,
  type CSSProperties,
  type ErrorInfo,
  type ReactNode,
  useEffect,
  useState,
} from "react";
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
    setStatus(
      window.piBridge
        ? "Waiting for Agent Host…"
        : "piBridge missing (preload failed?)",
    );

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
          <button
            type="button"
            onClick={() => void window.piBridge?.openLogs()}
            style={btnSecondary}
          >
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
          <div style={{ fontSize: 13, color: "#57534a", marginBottom: 8 }}>{status}</div>
          <div style={{ fontSize: 12, color: "#a19d92" }}>Pi Agent Desktop</div>
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
  background: "#f7f6f3",
  fontFamily: "Inter, system-ui, sans-serif",
};

const cardStyle: CSSProperties = {
  maxWidth: 520,
  background: "#fcfbf9",
  border: "1px solid #e4e1da",
  borderRadius: 12,
  padding: "28px 32px",
};

const titleStyle: CSSProperties = {
  fontSize: 18,
  margin: "0 0 12px",
  fontFamily: "ui-monospace, monospace",
};

const bodyStyle: CSSProperties = {
  fontSize: 13.5,
  lineHeight: 1.55,
  color: "#57534a",
  margin: "0 0 8px",
};

const preStyle: CSSProperties = {
  fontSize: 11,
  overflow: "auto",
  maxHeight: 200,
  background: "#1c1a17",
  color: "#faf9f7",
  padding: 12,
  borderRadius: 8,
};

const btnPrimary: CSSProperties = {
  marginTop: 16,
  padding: "8px 14px",
  borderRadius: 8,
  border: "1px solid #e4e1da",
  background: "#1c1a17",
  color: "#faf9f7",
  cursor: "pointer",
};

const btnSecondary: CSSProperties = {
  ...btnPrimary,
  marginLeft: 8,
  background: "#fcfbf9",
  color: "#1c1a17",
};
