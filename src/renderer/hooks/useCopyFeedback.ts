import { useCallback, useEffect, useState } from "react";
import { copyText } from "@/lib/clipboard";
import { CopyFeedbackTimer, performCopyWithFeedback } from "@/lib/copy-feedback";

export function useCopyFeedback(durationMs = 1_500): { copied: boolean; copy: (text: string) => Promise<boolean> } {
  const [copied, setCopied] = useState(false);
  const [timer] = useState(() => new CopyFeedbackTimer());
  useEffect(() => () => timer.dispose(), [timer]);
  const copy = useCallback(
    (text: string) => performCopyWithFeedback(text, copyText, timer, setCopied, durationMs),
    [durationMs, timer],
  );
  return { copied, copy };
}
