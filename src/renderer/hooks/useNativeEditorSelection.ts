import { useEffect, type RefObject } from "react";

/** Chromium's native accessibility selection can bypass React's select event. */
export function useNativeEditorSelection(ref: RefObject<HTMLTextAreaElement | null>, publish: () => void) {
  useEffect(() => {
    const input = ref.current;
    if (!input?.addEventListener) return;
    let start = -1,
      end = -1;
    let timer: ReturnType<typeof setInterval> | undefined;
    const sample = () => {
      if (input.selectionStart === start && input.selectionEnd === end) return;
      start = input.selectionStart;
      end = input.selectionEnd;
      publish();
    };
    const stop = () => {
      clearInterval(timer);
      timer = undefined;
    };
    const focus = () => {
      sample();
      // Some platform AX actions change the native range without a DOM event.
      if (timer === undefined) timer = setInterval(sample, 80);
    };
    input.addEventListener("selectionchange", sample);
    input.ownerDocument.addEventListener("selectionchange", sample);
    input.addEventListener("focus", focus);
    input.addEventListener("blur", stop);
    if (input.ownerDocument.activeElement === input) focus();
    return () => {
      stop();
      input.removeEventListener("selectionchange", sample);
      input.ownerDocument.removeEventListener("selectionchange", sample);
      input.removeEventListener("focus", focus);
      input.removeEventListener("blur", stop);
    };
  }, [ref, publish]);
}
