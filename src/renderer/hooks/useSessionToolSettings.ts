import { useCallback, useEffect, useRef, useState } from "react";
import { call, subscribe } from "@/lib/api-client";
import { sendAgentCommand } from "@/lib/agent-client";
import { LatestRequestGate } from "@/lib/latest-request-gate";
import type { BuiltinAgentCommand } from "@contract/agent-commands";
import type { ToolEntry } from "@shared/tool-presets";

export function useSessionToolSettings(sessionId: string | null) {
  const gate = useRef(new LatestRequestGate()).current;
  const view = useRef(0);
  const mutating = useRef(false);
  const [tools, setTools] = useState<ToolEntry[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [running, setRunning] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const load = useCallback(async () => {
    if (!sessionId) return;
    const ticket = gate.begin();
    try {
      const [next, snapshot] = await Promise.all([
        sendAgentCommand(sessionId, { type: "get_tools" }),
        call("agent.state", { sessionId }),
      ]);
      if (!gate.isCurrent(ticket)) return;
      setTools(next);
      const state = snapshot.state;
      setRunning(
        Boolean(
          state &&
          typeof state === "object" &&
          (("isPromptRunning" in state && state.isPromptRunning === true) ||
            ("isStreaming" in state && state.isStreaming === true)),
        ),
      );
      setLoaded(true);
      setError(undefined);
    } catch (e) {
      if (gate.isCurrent(ticket)) setError(e instanceof Error ? e.message : String(e));
    }
  }, [gate, sessionId]);
  useEffect(() => {
    setLoaded(false);
    setTools([]);
    setBusy(false);
    mutating.current = false;
    let disposed = false;
    const generation = view.current;
    let off: (() => void) | undefined;
    void load();
    if (sessionId)
      void subscribe("agent.events", sessionId, (event) => {
        if (!disposed && ["agent_start", "agent_end"].includes(event.type)) void load();
      })
        .then((value) => {
          if (disposed) value();
          else off = value;
        })
        .catch(() => undefined);
    const timer = sessionId ? window.setInterval(() => void load(), 15000) : undefined;
    return () => {
      disposed = true;
      view.current = generation + 1;
      gate.invalidate();
      off?.();
      if (timer !== undefined) window.clearInterval(timer);
    };
  }, [gate, load, sessionId]);
  const update = async (command: BuiltinAgentCommand) => {
    if (!sessionId || mutating.current || running || !loaded) return;
    const ticket = view.current;
    mutating.current = true;
    setBusy(true);
    setError(undefined);
    try {
      await sendAgentCommand(sessionId, command);
      if (view.current !== ticket) return;
      window.dispatchEvent(new CustomEvent("pi-desktop:session-tools-changed", { detail: { sessionId } }));
      await load();
    } catch (e) {
      if (view.current === ticket) setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (view.current === ticket) {
        mutating.current = false;
        setBusy(false);
      }
    }
  };
  return { tools, loaded, running, busy, error, update };
}
