import { useCallback } from "react";
import { useI18n } from "@/i18n";
import type { BuiltinSlashCommandResult } from "@/hooks/useAgentSession";
import type { AttachedImage, useComposerDraft } from "@/hooks/useComposerDraft";
import { localFileReferenceToMarkdown } from "@/lib/file-url";
import { captureComposerSubmission } from "@/lib/composer-submission";

export type ComposerSendResult = void | { ok?: boolean };

export interface ComposerActions {
  onSend: (message: string, images?: AttachedImage[]) => ComposerSendResult | Promise<ComposerSendResult>;
  onSteer?: (message: string, images?: AttachedImage[]) => Promise<void> | void;
  onFollowUp?: (message: string, images?: AttachedImage[]) => Promise<void> | void;
  onPromptWithStreamingBehavior?: (
    message: string,
    behavior: "steer" | "followUp",
    images?: AttachedImage[],
  ) => Promise<void> | void;
  onBuiltinCommand?: (message: string) => Promise<BuiltinSlashCommandResult>;
  onAudioUnlock?: () => void;
}

type SubmissionDraft = Pick<
  ReturnType<typeof useComposerDraft>,
  | "value"
  | "attachedImages"
  | "attachedFiles"
  | "getRevision"
  | "validateLocalFileReferences"
  | "setSubmissionNotice"
  | "commitCurrentDraft"
  | "restoreFailedSubmission"
>;

/** Submit a captured draft through one command path and restore failures by revision. */
export function useComposerSubmission({
  draft,
  clearInput,
  isStreaming,
  onSend,
  onSteer,
  onFollowUp,
  onPromptWithStreamingBehavior,
  onBuiltinCommand,
  onAudioUnlock,
}: ComposerActions & { draft: SubmissionDraft; clearInput: () => void; isStreaming: boolean }) {
  const { t } = useI18n();
  const {
    value,
    attachedImages,
    attachedFiles,
    getRevision,
    validateLocalFileReferences,
    setSubmissionNotice,
    commitCurrentDraft,
    restoreFailedSubmission,
  } = draft;

  const handleSend = useCallback(async () => {
    const text = value.trim();
    const msg = [text, ...attachedFiles.map(localFileReferenceToMarkdown)].filter(Boolean).join(" ");
    if (!msg && !attachedImages.length) return;
    if (isStreaming) return;
    const validationRevision = getRevision();
    if (!(await validateLocalFileReferences(attachedFiles))) return;
    if (validationRevision !== getRevision()) {
      setSubmissionNotice(t("draftChangedDuringValidation", "The draft changed while files were checked. Send again."));
      return;
    }
    onAudioUnlock?.();
    const snapshot = captureComposerSubmission(value, attachedImages, attachedFiles);
    setSubmissionNotice(null);
    commitCurrentDraft();
    clearInput();
    const clearedAtRevision = getRevision();
    try {
      if (!attachedImages.length && !attachedFiles.length && msg.startsWith("/") && onBuiltinCommand) {
        const result = await onBuiltinCommand(msg);
        if (result.handled) {
          if (result.error) restoreFailedSubmission(snapshot, clearedAtRevision, "send");
          return;
        }
      }
      const settled = await onSend(msg, attachedImages.length ? attachedImages : undefined);
      if (settled && typeof settled === "object" && "ok" in settled && settled.ok === false) {
        restoreFailedSubmission(snapshot, clearedAtRevision, "send");
        return;
      }
    } catch {
      restoreFailedSubmission(snapshot, clearedAtRevision, "send");
    }
  }, [
    attachedFiles,
    attachedImages,
    clearInput,
    commitCurrentDraft,
    getRevision,
    isStreaming,
    onAudioUnlock,
    onBuiltinCommand,
    onSend,
    restoreFailedSubmission,
    setSubmissionNotice,
    t,
    validateLocalFileReferences,
    value,
  ]);

  const sendQueued = useCallback(
    async (mode: "steer" | "followup") => {
      // Pi 0.84 queues image content but exposes only message strings through
      // queue_update/clearQueue. Keep images in the composer until the Agent is
      // idle so recall can never silently discard them.
      if (attachedImages.length > 0) {
        setSubmissionNotice(
          t("queuedImagesUnsupported", "Image messages can be sent after the current response finishes."),
        );
        return;
      }
      const msg = [value.trim(), ...attachedFiles.map(localFileReferenceToMarkdown)].filter(Boolean).join(" ");
      if (!msg && !attachedImages.length) return;
      const validationRevision = getRevision();
      if (!(await validateLocalFileReferences(attachedFiles))) return;
      if (validationRevision !== getRevision()) {
        setSubmissionNotice(
          t("draftChangedDuringValidation", "The draft changed while files were checked. Send again."),
        );
        return;
      }
      onAudioUnlock?.();
      const snapshot = captureComposerSubmission(value, attachedImages, attachedFiles);
      const streamingBehavior = mode === "steer" ? "steer" : "followUp";
      setSubmissionNotice(null);
      commitCurrentDraft();
      clearInput();
      const clearedAtRevision = getRevision();
      try {
        if (msg.startsWith("/") && onPromptWithStreamingBehavior) {
          await Promise.resolve(onPromptWithStreamingBehavior(msg, streamingBehavior));
          return;
        }
        if (mode === "steer" && onSteer) {
          await Promise.resolve(onSteer(msg));
        } else if (mode === "followup" && onFollowUp) {
          await Promise.resolve(onFollowUp(msg));
        }
      } catch {
        restoreFailedSubmission(snapshot, clearedAtRevision, "queue");
      }
    },
    [
      attachedFiles,
      attachedImages,
      clearInput,
      commitCurrentDraft,
      getRevision,
      onAudioUnlock,
      onFollowUp,
      onPromptWithStreamingBehavior,
      onSteer,
      restoreFailedSubmission,
      setSubmissionNotice,
      t,
      validateLocalFileReferences,
      value,
    ],
  );

  return { handleSend, sendQueued };
}
