import { randomUUID } from "node:crypto";
import { RpcError } from "../contract/types";
import type { RpcRequestContext } from "../contract/rpc";
import {
  editorDraftAfterEdit,
  type EditorDraft,
  type EditorDraftSync,
  type EditorMethod,
  type EditorVersion,
  type PendingEditorEdit,
} from "../shared/extension-editor";
import type { ExtensionUiRequest } from "../shared/types";

export function readEditorDraft(value: unknown): EditorDraft {
  const input = value as Partial<EditorDraft> | null;
  if (
    typeof input?.text !== "string" ||
    typeof input.start !== "number" ||
    typeof input.end !== "number" ||
    !Number.isSafeInteger(input.start) ||
    !Number.isSafeInteger(input.end) ||
    input.start < 0 ||
    input.end < input.start ||
    input.end > input.text.length
  )
    throw new RpcError({ code: "BAD_REQUEST", message: "Invalid editor draft or selection" });
  return { text: input.text, start: input.start, end: input.end };
}

/** An extension reads synchronously. Mirror the mounted composer's selection without persisting its draft. */
export class ExtensionEditor {
  private draft: EditorDraft = { text: "", start: 0, end: 0 };
  private readonly instance = randomUUID();
  private sequence = 0;
  pending?: PendingEditorEdit;

  constructor(private publish: (request: Extract<ExtensionUiRequest, { method: EditorMethod }>) => void) {}

  sync(draft: EditorDraft, applied?: EditorVersion) {
    if (applied?.instance === this.instance && applied.sequence < this.sequence) return false;
    if (this.pending && (applied?.instance !== this.instance || applied.sequence !== this.sequence)) return false;
    this.draft = draft;
    this.pending = undefined;
    return true;
  }

  private edit(method: EditorMethod, text: string) {
    this.draft = editorDraftAfterEdit(this.draft, method, text);
    const version = { instance: this.instance, sequence: ++this.sequence };
    this.pending = { version, draft: this.draft };
    this.publish({ type: "extension_ui_request", id: randomUUID(), method, text, editorVersion: version });
  }

  readonly bindings = {
    getEditorText: () => this.draft.text,
    setEditorText: (text: string) => this.edit("set_editor_text", text),
    pasteToEditor: (text: string) => this.edit("paste_editor_text", text),
  };
}

// The mounted view can outlive an idle SDK session, or precede its first start.
const mountedDrafts = new Map<string, { viewId: string; draft: EditorDraft }>();
export function mountedEditorDraft(sessionId: string) {
  return mountedDrafts.get(sessionId)?.draft;
}

export function syncEditorDraft(
  sessionId: string,
  editor: ExtensionEditor | undefined,
  command: EditorDraftSync,
  context?: RpcRequestContext,
) {
  const { viewId, applied } = command;
  if (typeof sessionId !== "string" || !sessionId)
    throw new RpcError({ code: "BAD_REQUEST", message: "Missing editor session" });
  if (typeof viewId !== "string" || !viewId)
    throw new RpcError({ code: "BAD_REQUEST", message: "Missing editor view" });
  const previous = mountedDrafts.get(sessionId);
  const lease = `editor-draft:${sessionId}:${viewId}`;
  if (command.draft === null) {
    if (context) context.releaseLease(lease);
    else if (previous?.viewId === viewId) mountedDrafts.delete(sessionId);
    return null;
  }
  if (previous && previous.viewId !== viewId && !command.attach) return null;
  const draft = readEditorDraft(command.draft);
  const accepted = editor?.sync(draft, applied);
  if (previous?.viewId === viewId && accepted !== false) previous.draft = draft;
  if (command.attach || previous?.viewId !== viewId) {
    const view = { viewId, draft: previous?.viewId === viewId ? previous.draft : draft };
    mountedDrafts.set(sessionId, view);
    context?.setLease(lease, () => {
      if (mountedDrafts.get(sessionId) === view) mountedDrafts.delete(sessionId);
    });
  }
  return command.attach === true ? (editor?.pending ?? null) : null;
}
