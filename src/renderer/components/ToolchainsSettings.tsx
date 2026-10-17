import { useEffect, useState } from "react";
import type { PublicToolchainState, ToolchainActionRequest } from "@shared/toolchains/types";
import { useI18n } from "@/i18n";
import { ToolchainStateView, actionKey, friendlyToolchainError } from "./ToolchainsConfig";
export function ToolchainsConfig({ cwd }: { cwd?: string | null }) {
  const { t } = useI18n();
  const [state, setState] = useState<PublicToolchainState | null>(null);
  const [pendingAction, setPendingAction] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let disposed = false;
    const unsubscribe = window.piBridge.onToolchainState((nextState) => {
      if (disposed) return;
      if (!cwd) {
        setState(nextState);
        setFailed(false);
        return;
      }
      void window.piBridge
        .getToolchainState(cwd)
        .then((projectState) => {
          if (!disposed) {
            setState(projectState);
            setFailed(false);
          }
        })
        .catch(() => {
          if (!disposed) setFailed(true);
        });
    });
    void window.piBridge
      .rescanToolchains(cwd ?? undefined)
      .then((nextState) => {
        if (!disposed) setState(nextState);
      })
      .catch(() => {
        if (!disposed) setFailed(true);
      });
    return () => {
      disposed = true;
      unsubscribe();
    };
  }, [cwd]);

  const performAction = async (request: ToolchainActionRequest): Promise<void> => {
    const actionId = actionKey(request);
    setPendingAction(actionId);
    setActionError(null);
    setFailed(false);
    try {
      const actionState =
        request.action === "rescan"
          ? await window.piBridge.rescanToolchains(cwd ?? undefined)
          : await window.piBridge.performToolchainAction(request);
      const nextState = cwd && request.action !== "rescan" ? await window.piBridge.getToolchainState(cwd) : actionState;
      setState(nextState);
    } catch (error) {
      if (!String(error).includes("TOOLCHAIN_CANCELLED")) setActionError(friendlyToolchainError(error, t));
    } finally {
      setPendingAction(null);
    }
  };

  return (
    <ToolchainStateView
      state={state}
      failed={failed}
      rescanPending={pendingAction === "rescan"}
      pendingAction={pendingAction}
      actionError={actionError}
      onRescan={() => void performAction({ action: "rescan" })}
      onAction={(request) => void performAction(request)}
    />
  );
}
