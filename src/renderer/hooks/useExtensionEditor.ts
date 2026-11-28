import { useEffect, useMemo, type RefObject } from "react";
import { syncEditorDraft } from "@/lib/api-client";
import {
  editorDraftAfterEdit,
  type EditorDraft,
  type EditorMethod,
  type EditorVersion,
  type PendingEditorEdit,
} from "@shared/extension-editor";

export interface ComposerEditorHandle {
  getEditorDraft(): EditorDraft;
  applyEditorDraft(draft: EditorDraft): void;
}

export function useExtensionEditor(
  sessionId: RefObject<string | null>,
  getViewSignal: () => AbortSignal,
  composer?: RefObject<ComposerEditorHandle | null>,
) {
  const connection = useMemo(() => {
    const viewId = globalThis.crypto.randomUUID();
    let applied: EditorVersion | undefined;
    let reconnect = false;
    let last: { sid: string; draft: EditorDraft; version?: EditorVersion } | undefined;

    function publish(draft: EditorDraft, attach = false) {
      const sid = sessionId.current,
        signal = getViewSignal();
      if (!sid || signal.aborted) return;
      attach ||= reconnect || last?.sid !== sid;
      if (
        !attach &&
        last &&
        last.version === applied &&
        draft.text === last.draft.text &&
        draft.start === last.draft.start &&
        draft.end === last.draft.end
      )
        return;
      const sent = { sid, draft, version: applied };
      last = sent;
      reconnect = false;
      void syncEditorDraft({ sessionId: sid, viewId, draft, applied, attach })
        .then((pending) => {
          if (
            pending &&
            last?.sid === sid &&
            !signal.aborted &&
            getViewSignal() === signal &&
            sessionId.current === sid
          )
            restore(pending);
        })
        .catch(() => {
          if (last === sent) reconnect = true;
        });
    }
    function apply(draft: EditorDraft, version?: EditorVersion) {
      if (!composer?.current || getViewSignal().aborted) return;
      if (version && version.instance === applied?.instance && version.sequence <= applied.sequence) return;
      applied = version;
      composer.current.applyEditorDraft(draft);
      publish(draft);
    }
    function restore(pending: PendingEditorEdit) {
      apply(pending.draft, pending.version);
    }
    return {
      publish,
      restore,
      edit(method: EditorMethod, text: string, version?: EditorVersion) {
        const current = composer?.current?.getEditorDraft();
        if (current) apply(editorDraftAfterEdit(current, method, text), version);
      },
      attach() {
        const draft = composer?.current?.getEditorDraft();
        if (draft) publish(draft, true);
      },
      release() {
        if (last) void syncEditorDraft({ sessionId: last.sid, viewId, draft: null }).catch(() => {});
        last = undefined;
        applied = undefined;
      },
    };
  }, [sessionId, getViewSignal, composer]);
  useEffect(() => {
    connection.attach();
    return () => connection.release();
  }, [connection]);
  return connection;
}
