import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { importTestBundle } from "#test-bundle";

const { ExtensionEditor, syncEditorDraft, mountedEditorDraft } = await importTestBundle("extension-editor", {
  packages: "external",
  entryPoints: [path.join(import.meta.dirname, "extension-editor.ts")],
});

test("the synchronous extension API reads the mounted draft and selection before, between and after asynchronous edits", async () => {
  const events = [];
  const editor = new ExtensionEditor((event) => events.push(event));
  const draft = { text: "A selected B", start: 2, end: 10 };
  syncEditorDraft("session", undefined, { viewId: "mounted", draft });
  editor.sync(mountedEditorDraft("session"));
  const ui = editor.bindings;
  assert.equal(ui.getEditorText(), draft.text);
  await Promise.resolve();
  ui.pasteToEditor("日\r\n本");
  assert.equal(ui.getEditorText(), "A 日\n本 B");
  ui.pasteToEditor("!");
  assert.equal(ui.getEditorText(), "A 日\n本! B");
  const oldEdit = events[0],
    current = events[1];
  assert.deepEqual(
    events.map((e) => e.method),
    ["paste_editor_text", "paste_editor_text"],
  );
  const stale = { viewId: "mounted", draft, applied: oldEdit.editorVersion, attach: true };
  assert.equal(syncEditorDraft("session", editor, stale).version.sequence, current.editorVersion.sequence);
  assert.equal(ui.getEditorText(), "A 日\n本! B");
  const manual = { text: "the user kept editing", start: 0, end: 3 };
  assert.equal(syncEditorDraft("session", editor, { ...stale, draft: manual, applied: current.editorVersion }), null);
  assert.equal(ui.getEditorText(), manual.text);
  syncEditorDraft("session", editor, stale);
  assert.equal(ui.getEditorText(), manual.text, "late acknowledgements cannot undo newer edits");
  assert.deepEqual(mountedEditorDraft("session"), manual, "an idle SDK replacement can recover the visible draft");
  ui.setEditorText("replaced");
  ui.setEditorText("");
  assert.equal(ui.getEditorText(), "");
  assert.deepEqual(editor.pending.draft, { text: "", start: 0, end: 0 });
  assert.equal(events.at(-1).method, "set_editor_text");
});

test("unmount releases only its own cold draft and validation rejects malformed selections", () => {
  const draft = { text: "draft", start: 2, end: 4 };
  syncEditorDraft("other-session", undefined, { viewId: "new", draft });
  syncEditorDraft("other-session", undefined, { viewId: "previous", draft: null });
  assert.deepEqual(mountedEditorDraft("other-session"), draft);
  syncEditorDraft("cold", undefined, { viewId: "current", draft });
  syncEditorDraft("cold", undefined, { viewId: "current", draft: null });
  assert.equal(mountedEditorDraft("cold"), undefined);
  assert.throws(
    () => syncEditorDraft("cold", undefined, { viewId: "current", draft: { ...draft, end: 999 } }),
    (e) => e.code === "BAD_REQUEST",
  );
});

test("closing an old renderer port cannot release the draft attached through its replacement", () => {
  const port = () => {
    let release;
    return {
      setLease(_key, fn) {
        const old = release;
        release = fn;
        old?.();
      },
      releaseLease() {
        const old = release;
        release = undefined;
        old?.();
        return !!old;
      },
    };
  };
  const first = port(),
    second = port();
  const update = { viewId: "view", draft: { text: "first", start: 0, end: 0 }, attach: true };
  syncEditorDraft("reconnected", undefined, update, first);
  const newDraft = { text: "second", start: 3, end: 3 };
  syncEditorDraft("reconnected", undefined, { ...update, draft: newDraft }, second);
  syncEditorDraft("reconnected", undefined, { viewId: "view", draft: null }, first);
  assert.deepEqual(mountedEditorDraft("reconnected"), newDraft);
  second.releaseLease();
  assert.equal(mountedEditorDraft("reconnected"), undefined);
});
