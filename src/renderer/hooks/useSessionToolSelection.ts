import { useCallback, useRef, useState, type RefObject } from "react";
import { call } from "@/lib/api-client";
import { sendAgentCommand } from "@/lib/agent-client";
import {
  getPresetFromTools,
  getToolNamesForPreset,
  getSelectedToolNames,
  type ToolEntry,
  type ToolPreset,
} from "@shared/tool-presets";
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
  const [choices, setChoices] = useState<Array<Pick<ToolEntry, "name" | "available">>>([]);
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
          setChoices(tools);
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
  const loadShellTools = useCallback(async () => {
    const owns = captureCommandView(),
      request = gate.begin(),
      sid = sessionIdRef.current;
    try {
      const tools = await available();
      if (!owns() || !gate.isCurrent(request)) return;
      setChoices(tools);
      setError("");
      if (sid && sid === sessionIdRef.current && (!pending.current || pending.current.owner !== key)) {
        const names = getSelectedToolNames(tools as ToolEntry[]);
        desired.current = { owner: key, names };
        setSelected(names);
        setPreset(getPresetFromTools(tools as ToolEntry[]));
      }
    } catch (error) {
      if (owns() && gate.isCurrent(request)) setError(String(error));
    }
  }, [available, captureCommandView, sessionIdRef, setSelected, setPreset, gate, key]);
  const initialToolNames = useCallback(
    async () =>
      (desired.current && desired.current.owner === key ? desired.current.names : selected) ??
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
        const tools = next === "full" ? await available() : choices;
        if (owns() && intents.isCurrent(request)) {
          setChoices(tools);
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
    [apply, available, captureCommandView, choices, gate, intents, isActive, key],
  );
  const handleShellToolChange = useCallback(
    async (name: string, enabled: boolean) => {
      if (!["bash", "powershell"].includes(name)) return;
      if (enabled && !choices.some((tool) => tool.name === name && tool.available !== false)) return;
      if (!isActive()) return;
      const request = intents.begin();
      gate.invalidate();
      pending.current = { owner: key, request };
      const current =
        (desired.current && desired.current.owner === key ? desired.current.names : selected) ??
        getToolNamesForPreset(preset, choices);
      await apply([...current.filter((tool) => tool !== name), ...(enabled ? [name] : [])], "custom", request);
    },
    [apply, choices, preset, selected, gate, intents, isActive, key],
  );
  const active = selected ?? getToolNamesForPreset(preset, choices);
  return {
    loadTools,
    initialToolNames,
    handleToolPresetChange,
    handleShellToolChange,
    loadShellTools,
    shellTools: {
      error,
      tools: choices
        .filter((tool) => ["bash", "powershell"].includes(tool.name))
        .map((tool) => ({ ...tool, active: active.includes(tool.name) })),
    },
  };
}
