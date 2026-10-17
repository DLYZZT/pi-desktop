import { useCallback, useRef, useState, type RefObject } from "react";
import { call } from "@/lib/api-client";
import { sendAgentCommand } from "@/lib/agent-client";
import { getPresetFromTools, getToolNamesForPreset, getSelectedToolNames, type ToolPreset } from "@shared/tool-presets";
import { LatestRequestGate } from "@/lib/latest-request-gate";

export function useSessionToolSelection({
  cwd,
  owner,
  sessionIdRef,
  ensuringNewSessionRef,
  preset,
  setPreset,
  isActive,
  captureCommandView,
}: {
  cwd?: string | null;
  owner?: string | null;
  sessionIdRef: RefObject<string | null>;
  ensuringNewSessionRef: RefObject<Promise<string | null> | null>;
  preset: ToolPreset;
  setPreset: (preset: ToolPreset) => void;
  isActive: () => boolean;
  captureCommandView: () => () => boolean;
}) {
  const key = owner ?? cwd;
  const [selection, setSelection] = useState<{ owner?: string | null; names: string[] } | null>(null);
  const selected = selection && selection.owner === key ? selection.names : null;
  const setSelected = useCallback((names: string[]) => setSelection({ owner: key, names }), [key]);
  const [error, setError] = useState("");
  const gate = useRef(new LatestRequestGate()).current;
  const intents = useRef(new LatestRequestGate()).current;
  const desired = useRef<{ owner?: string | null; names: string[] } | null>(null);
  const pending = useRef<{ owner?: string | null; request: number } | null>(null);
  const loadTools = useCallback(
    async (sid: string) => {
      const owns = captureCommandView(),
        request = gate.begin();
      try {
        const tools = await sendAgentCommand(sid, { type: "get_tools" });
        if (tools && owns() && gate.isCurrent(request) && sessionIdRef.current === sid) {
          if (!pending.current || pending.current.owner !== key) {
            const names = getSelectedToolNames(tools);
            desired.current = { owner: key, names };
            setSelected(names);
            setPreset(getPresetFromTools(tools));
          }
        }
        return tools;
      } catch (error) {
        console.error("Failed to load tools:", error);
      }
    },
    [captureCommandView, gate, sessionIdRef, setPreset, setSelected, key],
  );
  const available = useCallback(async () => {
    const sid = sessionIdRef.current;
    if (sid) return (await sendAgentCommand(sid, { type: "get_tools" })) ?? [];
    return cwd ? ((await call("host.toolchain", { cwd }))?.codingTools ?? []) : [];
  }, [cwd, sessionIdRef]);
  const initialToolNames = useCallback(
    async () =>
      (desired.current && desired.current.owner === key ? desired.current.names : selected) ??
      // The Host captures the default executor when it creates the session.
      getToolNamesForPreset(preset, preset === "full" ? await available() : undefined),
    [available, preset, selected, key],
  );
  const apply = useCallback(
    async (names: string[], nextPreset: ToolPreset, request: number) => {
      const owns = captureCommandView();
      if (!isActive() || !intents.isCurrent(request)) return;
      gate.invalidate();
      desired.current = { owner: key, names };
      try {
        const sid = sessionIdRef.current ?? (await ensuringNewSessionRef.current);
        if (!owns() || !intents.isCurrent(request)) return;
        if (sid) await sendAgentCommand(sid, { type: "set_tools", toolNames: names });
        if (owns() && intents.isCurrent(request)) {
          gate.invalidate();
          setSelected(names);
          setPreset(nextPreset);
          setError("");
        }
      } catch (error) {
        if (owns() && intents.isCurrent(request)) {
          desired.current = null;
          setError(String(error));
        }
      } finally {
        if (pending.current?.request === request) pending.current = null;
      }
    },
    [captureCommandView, ensuringNewSessionRef, gate, isActive, sessionIdRef, setPreset, setSelected, intents, key],
  );
  const handleToolPresetChange = useCallback(
    async (next: "none" | "default" | "full") => {
      if (!isActive()) return;
      const owns = captureCommandView(),
        request = intents.begin();
      gate.invalidate();
      pending.current = { owner: key, request };
      try {
        const tools = next !== "none" ? await available() : undefined;
        if (owns() && intents.isCurrent(request)) {
          await apply(getToolNamesForPreset(next, tools), next, request);
        }
      } catch (error) {
        if (owns() && intents.isCurrent(request)) {
          desired.current = null;
          setError(String(error));
        }
      } finally {
        if (pending.current?.request === request) pending.current = null;
      }
    },
    [apply, available, captureCommandView, gate, intents, isActive, key],
  );
  return {
    loadTools,
    initialToolNames,
    handleToolPresetChange,
    toolSelectionError: error,
  };
}
