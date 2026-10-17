import { useEffect, useState } from "react";
import { codingToolAvailability } from "@shared/tool-presets";

/** Main's verified inventory supplies platform/capability information; the Renderer never probes PATH. */
export function useCodingToolChoices(cwd?: string) {
  const [tools, setTools] = useState<Array<{ name: string; available: boolean }>>([]);
  useEffect(() => {
    let active = true;
    const load = () => {
      void window.piBridge
        ?.getToolchainState?.(cwd)
        .then((state) => {
          if (active)
            setTools(
              codingToolAvailability(
                state.platform,
                Object.fromEntries(
                  Object.entries(state.capabilities).filter(([, capability]) => capability?.health === "healthy"),
                ),
              ),
            );
        })
        .catch(() => {
          if (active) setTools([]);
        });
    };
    load();
    const unsubscribe = window.piBridge?.onToolchainState?.(load);
    return () => {
      active = false;
      unsubscribe?.();
    };
  }, [cwd]);
  return tools;
}
