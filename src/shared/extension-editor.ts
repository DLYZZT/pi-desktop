export interface EditorDraft {
  text: string;
  start: number;
  end: number;
}

export type EditorMethod = "set_editor_text" | "paste_editor_text";
export interface EditorVersion {
  instance: string;
  sequence: number;
}
export interface PendingEditorEdit {
  version: EditorVersion;
  draft: EditorDraft;
}
export interface EditorDraftSync {
  viewId: string;
  draft: EditorDraft | null;
  applied?: EditorVersion;
  attach?: boolean;
}

export function editorDraftAfterEdit(draft: EditorDraft, method: EditorMethod, text: string): EditorDraft {
  const input = text.replace(/\r\n?/g, "\n");
  if (method === "set_editor_text") return { text: input, start: input.length, end: input.length };
  const caret = draft.start + input.length;
  return { text: draft.text.slice(0, draft.start) + input + draft.text.slice(draft.end), start: caret, end: caret };
}
