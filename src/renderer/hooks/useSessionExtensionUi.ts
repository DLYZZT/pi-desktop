import { useCallback, useEffect, useReducer, useRef, useState, type RefObject } from "react";
import type { ExtensionStatusItem, ExtensionWidgetItem, ExtensionUiRequest } from "@/lib/types";
import type { SessionRuntimeState } from "@contract/types";
import { sendAgentCommand } from "@/lib/agent-client";
import { NOTICE_VISIBLE_MS, noticeExpiryDelay, noticeReducer, type NoticeType } from "@/lib/notice-queue";
import type { RuntimeSnapshotTicket, SessionRuntimeGate } from "@/lib/session-runtime-gate";
import { useI18n } from "@/i18n";
import { modelSelectionNoticeText } from "@/lib/model-selection-notice";

type DialogRequest = Extract<ExtensionUiRequest, { method: "select" | "confirm" | "input" | "editor" }>;
type CustomRequest = Extract<ExtensionUiRequest, { method: "custom" }>;
type RequestOwner<T> = { request: T; sessionId: string; signal: AbortSignal; expiresAt?: number };

function createNoticeId(): string {
  return typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

/** Extension presentation and responses share the same session/request ownership. */
export function useSessionExtensionUi({
  sessionIdRef,
  getViewSignal,
  runtimeGate,
  chatInputRef,
}: {
  sessionIdRef: RefObject<string | null>;
  getViewSignal: () => AbortSignal;
  runtimeGate: SessionRuntimeGate;
  chatInputRef?: RefObject<{ insertText: (text: string) => void } | null>;
}) {
  const { t } = useI18n();
  const [extensionDialog, setExtensionDialog] = useState<DialogRequest | null>(null);
  const [extensionCustomUi, setExtensionCustomUi] = useState<CustomRequest | null>(null);
  const [extensionStatuses, setExtensionStatuses] = useState<ExtensionStatusItem[]>([]);
  const [extensionWidgets, setExtensionWidgets] = useState<ExtensionWidgetItem[]>([]);
  const [noticeState, dispatchNotice] = useReducer(noticeReducer, { visible: [], pending: [] });
  const dialogOwnerRef = useRef<RequestOwner<DialogRequest> | null>(null);
  const customOwnerRef = useRef<RequestOwner<CustomRequest> | null>(null);
  const customRequestsRef = useRef(new WeakMap<CustomRequest, RequestOwner<CustomRequest>>());

  const owns = useCallback(
    (owner: RequestOwner<DialogRequest | CustomRequest>) =>
      !owner.signal.aborted && owner.signal === getViewSignal() && owner.sessionId === sessionIdRef.current,
    [getViewSignal, sessionIdRef],
  );

  const addNotice = useCallback(
    (notice: { id?: string; message: string; type?: NoticeType }) => {
      if (getViewSignal().aborted) return;
      const message = notice.message.trim();
      if (!message) return;
      dispatchNotice({
        type: "add",
        notice: {
          id: notice.id ?? createNoticeId(),
          message,
          type: notice.type ?? "info",
          expiresAt: Date.now() + NOTICE_VISIBLE_MS,
        },
      });
    },
    [getViewSignal],
  );

  const applyExtensionSnapshot = useCallback(
    (state: SessionRuntimeState, ticket: RuntimeSnapshotTicket) => {
      if (getViewSignal().aborted) return;
      if (state.extensionStatuses !== undefined && runtimeGate.accept(ticket, "statuses"))
        setExtensionStatuses([
          ...(state.extensionStatuses ?? []),
          ...(state.modelSelectionNotice
            ? [{ key: "pi-model-selection", text: modelSelectionNoticeText(state.modelSelectionNotice, t) }]
            : []),
        ]);
      if (state.extensionWidgets !== undefined && runtimeGate.accept(ticket, "widgets"))
        setExtensionWidgets(state.extensionWidgets ?? []);
    },
    [getViewSignal, runtimeGate, t],
  );

  const respondToExtensionUi = useCallback(
    async (request: DialogRequest, response: { value: string } | { confirmed: boolean } | { cancelled: true }) => {
      const owner = dialogOwnerRef.current;
      if (!owner || owner.request !== request || !owns(owner)) return;
      // Consume before awaiting RPC, so double clicks can produce only one answer.
      dialogOwnerRef.current = null;
      setExtensionDialog(null);
      if (owner.expiresAt !== undefined && owner.expiresAt <= Date.now()) return;
      try {
        await sendAgentCommand(owner.sessionId, { type: "extension_ui_response", id: request.id, ...response });
      } catch (error) {
        console.error("Failed to send extension UI response:", error);
      }
    },
    [owns],
  );

  const sendExtensionCustomInput = useCallback(
    async (request: CustomRequest, data: string) => {
      const owner = customOwnerRef.current;
      if (!owner || customRequestsRef.current.get(request) !== owner || !owns(owner)) return;
      try {
        await sendAgentCommand(owner.sessionId, { type: "extension_ui_input", id: request.id, data });
      } catch (error) {
        console.error("Failed to send extension custom UI input:", error);
      }
    },
    [owns],
  );

  const handleExtensionUiRequest = useCallback(
    (request: ExtensionUiRequest) => {
      const signal = getViewSignal(),
        sid = sessionIdRef.current;
      if (signal.aborted || !sid) return;
      switch (request.method) {
        case "select":
        case "confirm":
        case "input":
        case "editor": {
          const expiresAt = request.expiresAt ?? (request.timeout ? Date.now() + request.timeout : undefined);
          if (expiresAt !== undefined && expiresAt <= Date.now()) return;
          dialogOwnerRef.current = { request, sessionId: sid, signal, expiresAt };
          setExtensionDialog(request);
          break;
        }
        case "notify":
          addNotice({ id: request.id, message: request.message, type: request.notifyType ?? "info" });
          break;
        case "setStatus":
          runtimeGate.touch("statuses");
          setExtensionStatuses((prev) => {
            const rest = prev.filter((item) => item.key !== request.statusKey);
            return request.statusText ? [...rest, { key: request.statusKey, text: request.statusText }] : rest;
          });
          break;
        case "setWidget":
          runtimeGate.touch("widgets");
          setExtensionWidgets((prev) => {
            const rest = prev.filter((item) => item.key !== request.widgetKey);
            return request.widgetLines
              ? [
                  ...rest,
                  {
                    key: request.widgetKey,
                    lines: request.widgetLines,
                    placement: request.widgetPlacement ?? "aboveEditor",
                  },
                ]
              : rest;
          });
          break;
        case "setTitle":
          if (request.title) document.title = request.title;
          break;
        case "set_editor_text":
          chatInputRef?.current?.insertText(request.text);
          break;
        case "custom": {
          const previous = customOwnerRef.current;
          if (request.closed) {
            if (previous && owns(previous) && previous.request.id === request.id) {
              customOwnerRef.current = null;
              setExtensionCustomUi(null);
            }
            break;
          }
          // Repaint updates retain ownership; closing/reopening even the same ID
          // creates a new owner, invalidating callbacks from the old panel.
          const owner =
            previous && owns(previous) && previous.request.id === request.id
              ? previous
              : { request, sessionId: sid, signal };
          owner.request = request;
          customRequestsRef.current.set(request, owner);
          customOwnerRef.current = owner;
          setExtensionCustomUi(request);
          break;
        }
      }
    },
    [addNotice, chatInputRef, getViewSignal, owns, runtimeGate, sessionIdRef],
  );

  useEffect(() => {
    const owner = dialogOwnerRef.current;
    if (!extensionDialog || !owner || owner.expiresAt === undefined) return;
    const timer = setTimeout(
      () => {
        if (dialogOwnerRef.current !== owner) return;
        dialogOwnerRef.current = null;
        setExtensionDialog(null);
      },
      Math.max(0, owner.expiresAt - Date.now()),
    );
    return () => clearTimeout(timer);
  }, [extensionDialog]);

  useEffect(() => {
    if (noticeState.visible.length === 0) return;
    const exiting = noticeState.visible.find((notice) => notice.exiting);
    const timer = exiting
      ? setTimeout(() => dispatchNotice({ type: "remove", id: exiting.id, now: Date.now() }), 180)
      : setTimeout(
          () => dispatchNotice({ type: "mark_oldest_exiting" }),
          noticeExpiryDelay(noticeState.visible[0], Date.now()),
        );
    return () => clearTimeout(timer);
  }, [noticeState.visible]);

  return {
    extensionDialog,
    extensionCustomUi,
    extensionStatuses,
    extensionWidgets,
    notices: noticeState.visible,
    addNotice,
    applyExtensionSnapshot,
    handleExtensionUiRequest,
    respondToExtensionUi,
    sendExtensionCustomInput,
  };
}
