import { useExtensionDialogs } from "./useExtensionDialogs";
import { useCallback, useEffect, useReducer, useRef, useState, type RefObject } from "react";
import type { ExtensionStatusItem, ExtensionWidgetItem, ExtensionUiRequest } from "@/lib/types";
import type { SessionRuntimeState } from "@contract/types";
import { sendAgentCommand } from "@/lib/agent-client";
import { NOTICE_VISIBLE_MS, noticeExpiryDelay, noticeReducer, type NoticeType } from "@/lib/notice-queue";
import type { RuntimeSnapshotTicket, SessionRuntimeGate } from "@/lib/session-runtime-gate";
import { useI18n } from "@/i18n";
import { modelSelectionNoticeText } from "@/lib/model-selection-notice";
import { useExtensionEditor, type ComposerEditorHandle } from "./useExtensionEditor";

type DialogRequest = Extract<ExtensionUiRequest, { method: "select" | "confirm" | "input" | "editor" }>;
type CustomRequest = Extract<ExtensionUiRequest, { method: "custom" }>;
type RequestOwner<T> = { request: T; sessionId: string; signal: AbortSignal; expiresAt?: number };

// A mounted chat can be replaced during reconnection or resource reload.
const reportedDiagnostics = new Set<string>();
const runtimeDiagnosticKey = /^pi-runtime-(?:warning|error)-[0-9a-f]{24}$/;
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
  chatInputRef?: RefObject<ComposerEditorHandle | null>;
}) {
  const { t } = useI18n();
  const editor = useExtensionEditor(sessionIdRef, getViewSignal, chatInputRef);
  const {
    dialog: extensionDialog,
    respond: respondToExtensionUi,
    open,
    close,
    restore,
  } = useExtensionDialogs(sessionIdRef, getViewSignal, runtimeGate);
  const [extensionCustomUi, setExtensionCustomUi] = useState<CustomRequest | null>(null);
  const [extensionStatuses, setExtensionStatuses] = useState<ExtensionStatusItem[]>([]);
  const [extensionWidgets, setExtensionWidgets] = useState<ExtensionWidgetItem[]>([]);
  const [noticeState, dispatchNotice] = useReducer(noticeReducer, { visible: [], pending: [] });
  const customOwnerRef = useRef<RequestOwner<CustomRequest> | null>(null);
  const customRequestsRef = useRef(new WeakMap<CustomRequest, RequestOwner<CustomRequest>>());
  const clearedDiagnostics = useRef(new Map<string, number>());

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

  const reportDiagnostic = useCallback(
    (key: string, message: string) => {
      const type = key.startsWith("pi-runtime-error-") ? "error" : "warning";
      // A Host that predates the picker fix can replay these as plain, possibly truncated runtime warnings.
      if (type === "warning" && message.startsWith('No models match pattern "')) return;
      const id = `${sessionIdRef.current}:${key}`;
      if (reportedDiagnostics.has(id)) return;
      if (reportedDiagnostics.size >= 2048) reportedDiagnostics.delete(reportedDiagnostics.values().next().value!);
      reportedDiagnostics.add(id);
      addNotice({ id, message, type });
    },
    [sessionIdRef, addNotice],
  );
  const applyExtensionSnapshot = useCallback(
    (state: SessionRuntimeState, ticket: RuntimeSnapshotTicket) => {
      if (getViewSignal().aborted) return;
      if (state.pendingDialogs) restore(state.pendingDialogs, ticket);
      if (state.pendingEditorEdit && runtimeGate.isCurrentRun(ticket)) editor.restore(state.pendingEditorEdit);
      if (state.extensionStatuses !== undefined && runtimeGate.accept(ticket, "diagnostics")) {
        for (const [key, sequence] of clearedDiagnostics.current) {
          if (ticket.sequence > sequence) clearedDiagnostics.current.delete(key);
        }
        for (const { key, text } of state.extensionStatuses ?? []) {
          if (runtimeDiagnosticKey.test(key) && !clearedDiagnostics.current.has(key)) reportDiagnostic(key, text);
        }
      }
      if (state.extensionStatuses !== undefined && runtimeGate.accept(ticket, "statuses")) {
        setExtensionStatuses([
          ...(state.extensionStatuses ?? []).filter(({ key }) => !runtimeDiagnosticKey.test(key)),
          ...(state.modelSelectionNotice
            ? [{ key: "pi-model-selection", text: modelSelectionNoticeText(state.modelSelectionNotice, t) }]
            : []),
        ]);
      }
      if (state.extensionWidgets !== undefined && runtimeGate.accept(ticket, "widgets"))
        setExtensionWidgets(state.extensionWidgets ?? []);
    },
    [getViewSignal, runtimeGate, t, reportDiagnostic, editor, restore],
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
        case "editor":
          open(request);
          break;
        case "dialog_closed":
          close(request.id);
          break;
        case "notify":
          addNotice({ id: request.id, message: request.message, type: request.notifyType ?? "info" });
          break;
        case "setStatus":
          if (runtimeDiagnosticKey.test(request.statusKey)) {
            // A pending snapshot can still carry the cleared key alongside other, current diagnostics.
            if (request.statusText) reportDiagnostic(request.statusKey, request.statusText);
            else clearedDiagnostics.current.set(request.statusKey, runtimeGate.capture().sequence);
            break;
          }
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
        case "paste_editor_text":
          editor.edit(request.method, request.text, request.editorVersion);
          break;
        case "restore_editor_draft":
          editor.restore(request.edit);
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
    [reportDiagnostic, addNotice, editor, getViewSignal, owns, runtimeGate, sessionIdRef, open, close],
  );

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
    editor,
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
