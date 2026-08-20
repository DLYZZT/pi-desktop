import React, {
  useRef,
  useState,
  useCallback,
  useEffect,
  useLayoutEffect,
  useImperativeHandle,
  forwardRef,
  KeyboardEvent,
} from "react";
import { createPortal } from "react-dom";
import { scaledChatFont } from "@/lib/chat-appearance";
import type {
  BuiltinSlashCommandResult,
  CompactResultInfo,
  QueuedMessages,
  SlashCommandInfo,
} from "@/hooks/useAgentSession";
import {
  DraftPersistenceController,
  MAX_PERSISTED_DRAFT_FILES,
  MAX_PERSISTED_DRAFT_IMAGES,
  MAX_PERSISTED_DRAFT_IMAGE_BYTES,
  getDraft,
  selectDraftImageAdditions,
  type ChatDraftImage,
} from "@/lib/draft-store";
import { LatestAbortableRequest } from "@/lib/latest-abortable-request";
import { buildAtInsertText, extractAtQuery, type AtQueryMatch, type FileIndexEntry } from "@/lib/file-fuzzy";
import {
  FileSuggestionLruCache,
  fileSuggestionCacheKey,
  projectFileSuggestionResponse,
  type FileSuggestionDegradedReason,
} from "@/lib/file-suggestion-client";
import { FolderIcon, getFileIcon } from "./FileIcons";
import { useIsMobile } from "@/hooks/useIsMobile";
import { useI18n } from "@/i18n";
import type { ModelCatalogStatus } from "@contract/types";
import { processImageFileBatch } from "@/lib/image-file-processing";
import {
  localFilePathKey,
  localFileReferenceToMarkdown,
  splitLocalFileReferenceMarkdown,
  type LocalFileReference,
} from "@/lib/file-url";
import {
  captureComposerSubmission,
  failedComposerSubmissionAction,
  mergeFailedSubmissionFiles,
  mergeFailedSubmissionImages,
  type ComposerSubmissionSnapshot,
} from "@/lib/composer-submission";

export interface AttachedImage {
  data: string; // base64, no prefix
  mimeType: string;
  previewUrl: string; // object URL for display
}

interface ModelOption {
  provider: string;
  modelId: string;
  name: string;
}

interface Props {
  onSend: (message: string, images?: AttachedImage[]) => void;
  onAbort: () => void;
  onSteer?: (message: string, images?: AttachedImage[]) => Promise<void> | void;
  onFollowUp?: (message: string, images?: AttachedImage[]) => Promise<void> | void;
  onPromptWithStreamingBehavior?: (
    message: string,
    behavior: "steer" | "followUp",
    images?: AttachedImage[],
  ) => Promise<void> | void;
  isStreaming: boolean;
  model?: { provider: string; modelId: string } | null;
  isAutoModelSelection?: boolean;
  modelNames?: Record<string, string>;
  modelList?: { id: string; name: string; provider: string }[];
  modelCatalog?: ModelCatalogStatus;
  modelRefreshing?: boolean;
  onModelChange?: (provider: string, modelId: string) => void;
  onModelsRefresh?: () => Promise<void> | void;
  onModelsRefreshCancel?: () => void;
  onCompact?: () => void;
  onAbortCompaction?: () => void;
  isCompacting?: boolean;
  compactError?: string | null;
  compactResult?: CompactResultInfo | null;
  toolPreset?: "none" | "default" | "full";
  onToolPresetChange?: (preset: "none" | "default" | "full") => void;
  thinkingLevel?: "auto" | "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
  onThinkingLevelChange?: (level: "auto" | "off" | "minimal" | "low" | "medium" | "high" | "xhigh") => void;
  availableThinkingLevels?: string[] | null;
  thinkingLevelMap?: Record<string, string | null> | null;
  retryInfo?: { attempt: number; maxAttempts: number; errorMessage?: string } | null;
  queuedMessages?: QueuedMessages | null;
  onRecallQueue?: () => void;
  slashCommands?: SlashCommandInfo[];
  slashCommandsLoading?: boolean;
  onLoadSlashCommands?: () => Promise<SlashCommandInfo[]> | SlashCommandInfo[];
  onBuiltinCommand?: (message: string) => Promise<BuiltinSlashCommandResult>;
  soundEnabled?: boolean;
  onSoundToggle?: () => void;
  onAudioUnlock?: () => void;
  draftKey?: string;
  /** Session working directory — enables the @ file autocomplete menu */
  cwd?: string | null;
}

export interface ChatInputHandle {
  insertText: (text: string) => void;
  insertIfEmpty: (text: string) => void;
  prependText: (text: string) => void;
  addFiles: (files: File[]) => void;
}

const TOOL_PRESETS = ["off", "default", "full"] as const;
const TOOL_PRESET_MAP: Record<"off" | "default" | "full", "none" | "default" | "full"> = {
  off: "none",
  default: "default",
  full: "full",
};
const COMPOSITION_END_ENTER_GRACE_MS = 100;
const MODEL_OPTION_COLLATOR = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

function compareModelOptions(a: ModelOption, b: ModelOption): number {
  return (
    MODEL_OPTION_COLLATOR.compare(a.name || a.modelId, b.name || b.modelId) ||
    MODEL_OPTION_COLLATOR.compare(a.provider, b.provider) ||
    MODEL_OPTION_COLLATOR.compare(a.modelId, b.modelId)
  );
}

const THINKING_LEVELS = ["auto", "off", "minimal", "low", "medium", "high", "xhigh"] as const;

function formatTokenCount(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`;
  if (tokens >= 1_000) return `${Math.round(tokens / 1_000)}k`;
  return tokens.toLocaleString();
}

type SlashCommandPaletteItem =
  | SlashCommandInfo
  | {
      name: string;
      description: string;
      source: "builtin";
    };

type SlashCommandSource = SlashCommandPaletteItem["source"];

const BUILTIN_SLASH_COMMANDS: SlashCommandPaletteItem[] = [
  { name: "compact", description: "Compress context, optionally with instructions", source: "builtin" },
  { name: "reload", description: "Reload extensions, skills, prompts, and tools", source: "builtin" },
  { name: "name", description: "Set the session display name", source: "builtin" },
  { name: "session", description: "Show session message, token, and cost stats", source: "builtin" },
  { name: "copy", description: "Copy the last assistant message", source: "builtin" },
];

const SLASH_SOURCES: SlashCommandSource[] = ["builtin", "extension", "prompt", "skill"];

const SLASH_SOURCE_GROUP_LABEL: Record<SlashCommandSource, string> = {
  builtin: "Built-in",
  extension: "Extensions",
  prompt: "Prompts",
  skill: "Skills",
};

const SLASH_SOURCE_ORDER: Record<SlashCommandSource, number> = {
  builtin: 0,
  extension: 1,
  prompt: 2,
  skill: 3,
};

function slashMatchRank(command: SlashCommandPaletteItem, query: string): number {
  const name = command.name.toLowerCase();
  const description = command.description?.toLowerCase() ?? "";
  if (name === query) return 0;
  if (name.startsWith(query)) return 1;
  if (name.includes(query)) return 2;
  if (description.includes(query)) return 3;
  return 4;
}

function imageToDraftImage(image: AttachedImage): ChatDraftImage {
  return { data: image.data, mimeType: image.mimeType };
}

function draftImageToAttachedImage(image: ChatDraftImage): AttachedImage {
  return {
    ...image,
    previewUrl: `data:${image.mimeType};base64,${image.data}`,
  };
}

function revokeImagePreview(image: AttachedImage): void {
  if (image.previewUrl.startsWith("blob:")) {
    URL.revokeObjectURL(image.previewUrl);
  }
}

function QueuedMessageRow({ kind, text }: { kind: "steer" | "follow-up"; text: string }) {
  const { t } = useI18n();
  const segments = splitLocalFileReferenceMarkdown(text);
  return (
    <div
      title={text}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        padding: "3px 10px",
        fontSize: scaledChatFont(12),
        color: "var(--text-muted)",
        minWidth: 0,
      }}
    >
      <span
        style={{
          flexShrink: 0,
          fontSize: scaledChatFont(10),
          fontFamily: "var(--font-mono)",
          padding: "1px 7px",
          borderRadius: 999,
          border: `1px solid ${kind === "steer" ? "color-mix(in srgb, var(--accent) 45%, transparent)" : "var(--border)"}`,
          color: kind === "steer" ? "var(--accent)" : "var(--text-dim)",
        }}
      >
        {kind === "steer" ? t("steer", "Steer") : t("followUp", "Follow-up")}
      </span>
      <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
        {segments.map((seg, i) =>
          seg.file === null ? (
            <span key={i}>{seg.text}</span>
          ) : (
            <span
              key={i}
              style={{
                display: "inline-flex",
                alignItems: "center",
                padding: "0 6px",
                margin: "0 2px",
                borderRadius: 4,
                border: "1px solid var(--border)",
                background: "var(--bg-subtle)",
                color: "var(--text)",
                fontSize: scaledChatFont(11),
                verticalAlign: "baseline",
              }}
            >
              {seg.text}
            </span>
          ),
        )}
      </span>
    </div>
  );
}

export const ChatInput = forwardRef<ChatInputHandle, Props>(function ChatInput(
  {
    onSend,
    onAbort,
    onSteer,
    onFollowUp,
    isStreaming,
    model,
    isAutoModelSelection,
    modelNames,
    modelList,
    modelCatalog,
    modelRefreshing,
    onModelChange,
    onModelsRefresh,
    onModelsRefreshCancel,
    onCompact,
    onAbortCompaction,
    isCompacting,
    compactError,
    compactResult,
    toolPreset,
    onToolPresetChange,
    thinkingLevel,
    onThinkingLevelChange,
    availableThinkingLevels,
    thinkingLevelMap,
    retryInfo,
    queuedMessages,
    onRecallQueue,
    slashCommands,
    slashCommandsLoading,
    onLoadSlashCommands,
    onBuiltinCommand,
    soundEnabled,
    onSoundToggle,
    onAudioUnlock,
    onPromptWithStreamingBehavior,
    draftKey,
    cwd,
  }: Props,
  ref,
) {
  const isMobile = useIsMobile();
  const { t, language } = useI18n();
  const [value, setValueState] = useState(() => (draftKey ? (getDraft(draftKey)?.value ?? "") : ""));
  const [modelDropdownOpen, setModelDropdownOpen] = useState(false);
  const [modelDropdownRect, setModelDropdownRect] = useState<{ top: number; left: number; width: number } | null>(null);
  const [toolDropdownOpen, setToolDropdownOpen] = useState(false);
  const [thinkingDropdownOpen, setThinkingDropdownOpen] = useState(false);
  const [attachedImages, setAttachedImagesState] = useState<AttachedImage[]>(() =>
    draftKey ? (getDraft(draftKey)?.images.map(draftImageToAttachedImage) ?? []) : [],
  );
  const [attachedFiles, setAttachedFilesState] = useState<LocalFileReference[]>(() =>
    draftKey ? (getDraft(draftKey)?.files?.map((file) => ({ ...file })) ?? []) : [],
  );
  const [fileInspectionByPath, setFileInspectionByPath] = useState<
    Map<string, { exists: boolean; isFile: boolean; insideCwd: boolean }>
  >(new Map());
  const [slashMenuOpen, setSlashMenuOpen] = useState(false);
  const [slashActiveIndex, setSlashActiveIndex] = useState(0);
  const [atQuery, setAtQuery] = useState<AtQueryMatch | null>(null);
  const [atMenuOpen, setAtMenuOpen] = useState(false);
  const [atActiveIndex, setAtActiveIndex] = useState(0);
  const [atSuggestionState, setAtSuggestionState] = useState<{
    cwd: string;
    tokenKey: string;
    query: string;
    matches: FileIndexEntry[];
    truncated: boolean;
    degradedReason?: FileSuggestionDegradedReason;
    status: "loading" | "ready" | "error";
  } | null>(null);
  const [imageAttachNotice, setImageAttachNotice] = useState<string | null>(null);
  const [submissionNotice, setSubmissionNotice] = useState<string | null>(null);

  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const modelButtonRef = useRef<HTMLButtonElement>(null);
  const modelDropdownPanelRef = useRef<HTMLDivElement>(null);
  const toolDropdownRef = useRef<HTMLDivElement>(null);
  const thinkingDropdownRef = useRef<HTMLDivElement>(null);
  const controlsMenuRef = useRef<HTMLDivElement>(null);
  const thinkingButtonRef = useRef<HTMLButtonElement>(null);
  const toolButtonRef = useRef<HTMLButtonElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const isComposingRef = useRef(false);
  const lastCompositionEndAtRef = useRef(0);
  const slashCommandsRequestedRef = useRef(false);
  const slashItemRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const atItemRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const fileSuggestionCacheRef = useRef(new FileSuggestionLruCache());
  const fileSuggestionRequestRef = useRef(new LatestAbortableRequest());
  const draftKeyRef = useRef(draftKey);
  const valueRef = useRef(value);
  const attachedImagesRef = useRef(attachedImages);
  const attachedFilesRef = useRef(attachedFiles);
  const imageBatchGenerationRef = useRef(0);
  const imageProcessingActiveRef = useRef(true);
  const pendingImagePreviewsRef = useRef(new Set<string>());
  const inputRevisionRef = useRef(0);
  const draftPersistenceErrorHandlerRef = useRef<() => void>(() => {});
  const draftPersistenceRef = useRef<DraftPersistenceController | null>(null);
  draftPersistenceErrorHandlerRef.current = () =>
    setSubmissionNotice(
      t(
        "draftPersistenceFailed",
        "Draft could not be saved on this device. Your current input is still on screen; check available storage.",
      ),
    );
  if (!draftPersistenceRef.current) {
    draftPersistenceRef.current = new DraftPersistenceController(500, undefined, () =>
      draftPersistenceErrorHandlerRef.current(),
    );
  }
  const setValue = useCallback((next: React.SetStateAction<string>) => {
    const resolved = typeof next === "function" ? next(valueRef.current) : next;
    inputRevisionRef.current += 1;
    valueRef.current = resolved;
    setValueState(resolved);
  }, []);
  const setAttachedImages = useCallback((next: React.SetStateAction<AttachedImage[]>) => {
    const resolved = typeof next === "function" ? next(attachedImagesRef.current) : next;
    inputRevisionRef.current += 1;
    attachedImagesRef.current = resolved;
    setAttachedImagesState(resolved);
  }, []);
  const setAttachedFiles = useCallback((next: React.SetStateAction<LocalFileReference[]>) => {
    const resolved = typeof next === "function" ? next(attachedFilesRef.current) : next;
    inputRevisionRef.current += 1;
    attachedFilesRef.current = resolved;
    setAttachedFilesState(resolved);
  }, []);
  valueRef.current = value;
  attachedImagesRef.current = attachedImages;
  attachedFilesRef.current = attachedFiles;

  useImperativeHandle(ref, () => ({
    insertIfEmpty(text: string) {
      const ta = textareaRef.current;
      const current = ta ? ta.value : value;
      if (current.trim()) return;
      setValue(text);
      setAtQuery(null);
      requestAnimationFrame(() => {
        if (!ta) return;
        ta.focus();
        ta.style.height = "auto";
        ta.style.height = `${Math.min(ta.scrollHeight, 200)}px`;
      });
    },
    prependText(text: string) {
      if (!text.trim()) return;
      const ta = textareaRef.current;
      const current = ta ? ta.value : value;
      // Mirrors the TUI's queue restore: queued text first, then whatever
      // the user already typed, separated by a blank line.
      const combined = [text, current].filter((t) => t.trim()).join("\n\n");
      setValue(combined);
      setAtQuery(null);
      requestAnimationFrame(() => {
        if (!ta) return;
        ta.focus();
        ta.setSelectionRange(combined.length, combined.length);
        ta.style.height = "auto";
        ta.style.height = `${Math.min(ta.scrollHeight, 200)}px`;
      });
    },
    insertText(text: string) {
      const ta = textareaRef.current;
      if (!ta) {
        setValue((v) => v + (v ? " " : "") + text);
        return;
      }
      const start = ta.selectionStart ?? ta.value.length;
      const end = ta.selectionEnd ?? ta.value.length;
      const before = ta.value.slice(0, start);
      const after = ta.value.slice(end);
      const sep = before.length > 0 && !before.endsWith(" ") ? " " : "";
      const newVal = before + sep + text + after;
      setValue(newVal);
      setAtQuery(null);
      requestAnimationFrame(() => {
        if (!ta) return;
        const pos = start + sep.length + text.length;
        ta.setSelectionRange(pos, pos);
        ta.focus();
        ta.style.height = "auto";
        ta.style.height = `${Math.min(ta.scrollHeight, 200)}px`;
      });
    },
    addFiles(files: File[]) {
      void processFiles(files);
    },
  }));

  const processImageAttachments = useCallback(
    async (imageFiles: File[]): Promise<string[]> => {
      if (imageFiles.length === 0) return [];
      const generation = ++imageBatchGenerationRef.current;
      const { images, failures } = await processImageFileBatch(imageFiles);
      if (!imageProcessingActiveRef.current) {
        images.forEach(revokeImagePreview);
        return [];
      }
      const notices: string[] = [];
      if (images.length > 0) {
        const selection = selectDraftImageAdditions(attachedImagesRef.current, images);
        selection.accepted.forEach((image) => pendingImagePreviewsRef.current.add(image.previewUrl));
        selection.rejected.forEach(({ image }) => revokeImagePreview(image));
        if (selection.accepted.length > 0) {
          setAttachedImages((prev) => [...prev, ...selection.accepted]);
        }
        if (selection.rejected.some(({ reason }) => reason === "count")) {
          notices.push(
            t(
              "draftImageCountLimit",
              "A draft can save up to {count} images. Remove an image before adding another.",
            ).replace("{count}", String(MAX_PERSISTED_DRAFT_IMAGES)),
          );
        }
        if (selection.rejected.some(({ reason }) => reason === "bytes")) {
          notices.push(
            t(
              "draftImageSizeLimit",
              "The total image size exceeds the {size} MB draft limit. Remove or compress some images.",
            ).replace("{size}", String(MAX_PERSISTED_DRAFT_IMAGE_BYTES / 1024 / 1024)),
          );
        }
      }
      if (generation === imageBatchGenerationRef.current && failures.length > 0) {
        notices.push(
          images.length > 0
            ? t("someImagesAttachFailed", "{failed} of {total} images could not be attached")
                .replace("{failed}", String(failures.length))
                .replace("{total}", String(imageFiles.length))
            : t("imagesAttachFailed", "The selected images could not be attached"),
        );
      }
      return notices;
    },
    [setAttachedImages, t],
  );

  const processLocalFileReferences = useCallback(
    (files: File[]): string[] => {
      if (files.length === 0) return [];
      const notices: string[] = [];
      const newFiles: LocalFileReference[] = [];
      let pathlessCount = 0;
      for (const file of files) {
        const absolutePath = window.piBridge?.getPathForFile?.(file) ?? "";
        if (absolutePath) newFiles.push({ name: file.name, path: absolutePath });
        else pathlessCount += 1;
      }
      if (pathlessCount > 0) {
        notices.push(
          t("pathlessFilesAttachFailed", "{count} files had no local path and were not added").replace(
            "{count}",
            String(pathlessCount),
          ),
        );
      }
      if (newFiles.length === 0) return notices;

      const next = [...attachedFilesRef.current];
      const seen = new Set(next.map((file) => localFilePathKey(file.path)));
      let limitReached = false;
      for (const file of newFiles) {
        const key = localFilePathKey(file.path);
        if (!key || seen.has(key)) continue;
        if (next.length >= MAX_PERSISTED_DRAFT_FILES) {
          limitReached = true;
          break;
        }
        seen.add(key);
        next.push(file);
      }
      setAttachedFiles(next);
      if (limitReached) {
        notices.push(
          t("localFileReferenceLimit", "A maximum of {count} local file references can be added").replace(
            "{count}",
            String(MAX_PERSISTED_DRAFT_FILES),
          ),
        );
      }
      return notices;
    },
    [setAttachedFiles, t],
  );

  const processFiles = useCallback(
    async (files: File[]) => {
      // Attaching is allowed while streaming; sending is gated separately,
      // so the user can prepare files for the next prompt while the agent runs.
      const imageFiles = files.filter((file) => file.type.startsWith("image/"));
      const localFiles = files.filter((file) => !file.type.startsWith("image/"));
      const notices = await processImageAttachments(imageFiles);
      if (!imageProcessingActiveRef.current) return;
      notices.push(...processLocalFileReferences(localFiles));
      setImageAttachNotice(notices.length > 0 ? notices.join(". ") : null);
    },
    [processImageAttachments, processLocalFileReferences],
  );

  const removeImage = useCallback(
    (index: number) => {
      setAttachedImages((prev) => {
        const next = [...prev];
        const [removed] = next.splice(index, 1);
        if (removed) revokeImagePreview(removed);
        return next;
      });
    },
    [setAttachedImages],
  );

  const clearImages = useCallback(() => {
    setAttachedImages((prev) => {
      prev.forEach(revokeImagePreview);
      return [];
    });
  }, [setAttachedImages]);

  const removeFile = useCallback(
    (index: number) => {
      setAttachedFiles((prev) => prev.filter((_, i) => i !== index));
    },
    [setAttachedFiles],
  );

  const clearInput = useCallback(() => {
    setValue("");
    setAtQuery(null);
    if (draftKey) draftPersistenceRef.current?.clear(draftKey);
    if (draftKeyRef.current && draftKeyRef.current !== draftKey) {
      draftPersistenceRef.current?.clear(draftKeyRef.current);
    }
    clearImages();
    setAttachedFiles([]);
    if (textareaRef.current) {
      textareaRef.current.style.height = "auto";
    }
  }, [clearImages, draftKey, setAttachedFiles, setValue]);

  const restoreFailedSubmission = useCallback(
    (snapshot: ComposerSubmissionSnapshot, clearedAtRevision: number, kind: "send" | "queue") => {
      const action = failedComposerSubmissionAction(clearedAtRevision, inputRevisionRef.current);
      if (action === "restore") {
        setValue(snapshot.value);
        setAttachedImages(snapshot.images);
        setAttachedFiles(snapshot.files ?? []);
      } else {
        if (snapshot.images.length > 0) {
          setAttachedImages((current) => mergeFailedSubmissionImages(current, snapshot.images));
        }
        if (snapshot.files.length > 0) {
          setAttachedFiles((current) => mergeFailedSubmissionFiles(current, snapshot.files));
        }
      }
      setSubmissionNotice(
        action === "restore"
          ? kind === "send"
            ? t("messageNotSentDraftRestored", "Message was not sent. Your draft was restored.")
            : t("messageNotQueuedDraftRestored", "Message could not be queued. Your draft was restored.")
          : kind === "send"
            ? t("messageNotSentNewDraftKept", "The previous message was not sent. Your newer draft was kept.")
            : t("messageNotQueuedNewDraftKept", "The previous message could not be queued. Your newer draft was kept."),
      );
    },
    [setAttachedFiles, setAttachedImages, setValue, t],
  );

  const commitCurrentDraft = useCallback(() => {
    const currentDraftKey = draftKeyRef.current;
    if (!currentDraftKey) return;
    draftPersistenceRef.current?.commit(currentDraftKey, {
      value: valueRef.current,
      images: attachedImagesRef.current.map(imageToDraftImage),
      files: attachedFilesRef.current,
    });
  }, []);

  useEffect(() => {
    if (!draftKey || draftKeyRef.current !== draftKey) return;
    draftPersistenceRef.current?.schedule(draftKey, {
      value,
      images: attachedImages.map(imageToDraftImage),
      files: attachedFiles,
    });
  }, [attachedFiles, attachedImages, draftKey, value]);

  useEffect(() => {
    const previousDraftKey = draftKeyRef.current;
    if (previousDraftKey === draftKey) return;

    if (previousDraftKey) {
      draftPersistenceRef.current?.commit(previousDraftKey, {
        value: valueRef.current,
        images: attachedImagesRef.current.map(imageToDraftImage),
        files: attachedFilesRef.current,
      });
    }

    const draft = draftKey ? getDraft(draftKey) : null;
    draftKeyRef.current = draftKey;
    setValue(draft?.value ?? "");
    setAtQuery(null);
    setAttachedImages((prev) => {
      prev.forEach(revokeImagePreview);
      return draft?.images.map(draftImageToAttachedImage) ?? [];
    });
    setAttachedFiles(draft?.files?.map((file) => ({ ...file })) ?? []);
  }, [draftKey, setAttachedFiles, setAttachedImages, setValue]);

  useEffect(() => {
    const ta = textareaRef.current;
    if (!ta) return;
    ta.style.height = "auto";
    if (value) ta.style.height = `${Math.min(ta.scrollHeight, 200)}px`;
  }, [value]);

  useEffect(() => {
    let cancelled = false;
    if (attachedFiles.length === 0 || !window.piBridge?.inspectLocalFiles) {
      setFileInspectionByPath(new Map());
      return () => {
        cancelled = true;
      };
    }
    void window.piBridge
      .inspectLocalFiles({ paths: attachedFiles.map((file) => file.path), cwd: cwd ?? undefined })
      .then((inspections) => {
        if (cancelled) return;
        const next = new Map<string, { exists: boolean; isFile: boolean; insideCwd: boolean }>();
        inspections.forEach((inspection, index) => {
          const file = attachedFiles[index];
          if (file) next.set(localFilePathKey(file.path), inspection);
        });
        setFileInspectionByPath(next);
      })
      .catch(() => {
        if (!cancelled) setFileInspectionByPath(new Map());
      });
    return () => {
      cancelled = true;
    };
  }, [attachedFiles, cwd]);

  useEffect(() => {
    for (const image of attachedImages) pendingImagePreviewsRef.current.delete(image.previewUrl);
  }, [attachedImages]);

  useEffect(() => {
    const pendingPreviews = pendingImagePreviewsRef.current;
    imageProcessingActiveRef.current = true;
    return () => {
      imageProcessingActiveRef.current = false;
      commitCurrentDraft();
      draftPersistenceRef.current?.dispose();
      for (const previewUrl of pendingPreviews) URL.revokeObjectURL(previewUrl);
      pendingPreviews.clear();
      attachedImagesRef.current.forEach(revokeImagePreview);
    };
  }, [commitCurrentDraft]);

  const validateLocalFileReferences = useCallback(
    async (files: readonly LocalFileReference[]): Promise<boolean> => {
      if (files.length === 0) return true;
      const inspections = await window.piBridge?.inspectLocalFiles?.({
        paths: files.map((file) => file.path),
        cwd: cwd ?? undefined,
      });
      if (!inspections || inspections.length !== files.length) {
        setSubmissionNotice(t("localFileValidationFailed", "Local file references could not be validated."));
        return false;
      }
      const invalidNames = files
        .filter((_file, index) => !inspections[index]?.exists || !inspections[index]?.isFile)
        .map((file) => file.name);
      if (invalidNames.length > 0) {
        setSubmissionNotice(
          t("localFilesUnavailable", "These local files are missing or unavailable: {files}").replace(
            "{files}",
            invalidNames.join(", "),
          ),
        );
        return false;
      }
      return true;
    },
    [cwd, t],
  );

  const handleSend = useCallback(async () => {
    const text = value.trim();
    const msg = [text, ...attachedFiles.map(localFileReferenceToMarkdown)].filter(Boolean).join(" ");
    if (!msg && !attachedImages.length) return;
    if (isStreaming) return;
    const validationRevision = inputRevisionRef.current;
    if (!(await validateLocalFileReferences(attachedFiles))) return;
    if (validationRevision !== inputRevisionRef.current) {
      setSubmissionNotice(t("draftChangedDuringValidation", "The draft changed while files were checked. Send again."));
      return;
    }
    onAudioUnlock?.();
    const snapshot = captureComposerSubmission(value, attachedImages, attachedFiles);
    setSubmissionNotice(null);
    commitCurrentDraft();
    clearInput();
    const clearedAtRevision = inputRevisionRef.current;
    try {
      if (!attachedImages.length && !attachedFiles.length && msg.startsWith("/") && onBuiltinCommand) {
        const result = await onBuiltinCommand(msg);
        if (result.handled) {
          if (result.error) restoreFailedSubmission(snapshot, clearedAtRevision, "send");
          return;
        }
      }
      const result = onSend(msg, attachedImages.length ? attachedImages : undefined) as
        void | Promise<unknown> | { ok?: boolean };
      const settled = await Promise.resolve(result);
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
    isStreaming,
    onAudioUnlock,
    onBuiltinCommand,
    onSend,
    restoreFailedSubmission,
    t,
    validateLocalFileReferences,
    value,
  ]);

  const slashQuery = value.startsWith("/") && !/\s/.test(value.slice(1)) ? value.slice(1).toLowerCase() : null;

  const filteredSlashCommands = (() => {
    if (slashQuery === null) return [];
    const commands = [...(isStreaming ? [] : BUILTIN_SLASH_COMMANDS), ...(slashCommands ?? [])];
    return [...commands]
      .filter((command) => {
        const name = command.name.toLowerCase();
        const description = command.description?.toLowerCase() ?? "";
        return name.includes(slashQuery) || description.includes(slashQuery);
      })
      .sort((a, b) => {
        const rankDelta = slashMatchRank(a, slashQuery) - slashMatchRank(b, slashQuery);
        if (rankDelta !== 0) return rankDelta;
        return (
          SLASH_SOURCE_ORDER[a.source] - SLASH_SOURCE_ORDER[b.source] || MODEL_OPTION_COLLATOR.compare(a.name, b.name)
        );
      });
  })();

  const groupedSlashCommands = (() => {
    const groups = new Map<
      SlashCommandSource,
      { source: SlashCommandSource; items: { command: SlashCommandPaletteItem; index: number }[] }
    >();
    for (const source of SLASH_SOURCES) {
      groups.set(source, { source, items: [] });
    }
    filteredSlashCommands.forEach((command, index) => {
      groups.get(command.source)?.items.push({ command, index });
    });
    return SLASH_SOURCES.map((source) => groups.get(source)!).filter((group) => group.items.length > 0);
  })();

  const slashCommandCountLabel =
    filteredSlashCommands.length === 1
      ? slashQuery
        ? t("oneMatch", "1 match")
        : t("oneCommand", "1 command")
      : slashQuery
        ? t("matchCount", "{count} matches").replace("{count}", String(filteredSlashCommands.length))
        : t("commandCount", "{count} commands").replace("{count}", String(filteredSlashCommands.length));
  const hasInputText = Boolean(value.trim());
  const canQueueStreamingMessage = hasInputText || attachedFiles.length > 0 || attachedImages.length > 0;

  // ── @ file autocomplete ──────────────────────────────────────────────────
  // Recomputed from the text before the caret on every change/caret move.
  // Disabled entirely when there is no cwd (new session without a directory).
  const updateAtQuery = useCallback(
    (text: string, cursor: number | null) => {
      if (!cwd) {
        setAtQuery(null);
        return;
      }
      const pos = cursor ?? text.length;
      setAtQuery(extractAtQuery(text.slice(0, pos)));
    },
    [cwd],
  );

  const atQueryText = atQuery?.query ?? null;
  // Open/reset the menu whenever the @token appears or changes (mirrors the
  // slash menu: Escape closes it, the next keystroke re-opens it).
  const atTokenKey = atQuery === null ? null : `${atQuery.start}:${atQuery.quoted ? 1 : 0}:${atQuery.query}`;
  useEffect(() => {
    if (atTokenKey === null) {
      setAtMenuOpen(false);
      setAtActiveIndex(0);
      return;
    }
    setAtMenuOpen(true);
    setAtActiveIndex(0);
  }, [atTokenKey]);

  // Request candidates for the active token. Empty queries and directory
  // drill-down browse immediately; non-empty searches debounce briefly. The
  // request generation and token tag both prevent stale responses from
  // replacing a newer query.
  useEffect(() => {
    if (atTokenKey === null || atQueryText === null || !cwd) {
      fileSuggestionRequestRef.current.cancel();
      setAtSuggestionState(null);
      return;
    }
    const fetchCwd = cwd;
    const query = atQueryText;
    const tokenKey = atTokenKey;
    const platform = window.piBridge?.platform ?? "linux";
    const cacheKey = fileSuggestionCacheKey(fetchCwd, query, platform);
    const cached = fileSuggestionCacheRef.current.get(cacheKey);
    if (cached) {
      setAtSuggestionState({ cwd: fetchCwd, tokenKey, query, ...cached, status: "ready" });
      return;
    }

    setAtSuggestionState({ cwd: fetchCwd, tokenKey, query, matches: [], truncated: false, status: "loading" });
    const requests = fileSuggestionRequestRef.current;
    let generation: number | null = null;
    const timer = setTimeout(
      () => {
        const request = requests.begin();
        generation = request.generation;
        fetch(`/api/file-index?cwd=${encodeURIComponent(fetchCwd)}&q=${encodeURIComponent(query)}`, {
          signal: request.signal,
        })
          .then((res) => {
            if (!res.ok) throw new Error(`file suggestions failed: ${res.status}`);
            return res.json() as Promise<unknown>;
          })
          .then((data) => {
            if (!requests.isCurrent(request.generation)) return;
            const snapshot = projectFileSuggestionResponse(data, query);
            fileSuggestionCacheRef.current.setWithTtl(
              cacheKey,
              snapshot,
              query === "" || query.endsWith("/") ? 2_000 : 1_000,
            );
            setAtSuggestionState({ cwd: fetchCwd, tokenKey, query, ...snapshot, status: "ready" });
          })
          .catch((error) => {
            if (!requests.isCurrent(request.generation) || (error as { name?: string })?.name === "AbortError") return;
            setAtSuggestionState({
              cwd: fetchCwd,
              tokenKey,
              query,
              matches: [],
              truncated: false,
              status: "error",
            });
          })
          .finally(() => requests.finish(request.generation));
      },
      query === "" || query.endsWith("/") ? 0 : 150,
    );
    return () => {
      clearTimeout(timer);
      if (generation !== null) requests.cancel(generation);
    };
  }, [atTokenKey, atQueryText, cwd]);

  const suggestionStateInUse =
    atSuggestionState !== null && atSuggestionState.cwd === cwd && atSuggestionState.tokenKey === atTokenKey;
  const activeSuggestionState = suggestionStateInUse ? atSuggestionState : null;
  const atMatches: FileIndexEntry[] = React.useMemo(
    () => activeSuggestionState?.matches ?? [],
    [activeSuggestionState],
  );

  const applyAtCompletion = useCallback(
    (entry: FileIndexEntry) => {
      if (!atQuery) return;
      const ta = textareaRef.current;
      const cursor = ta?.selectionStart ?? value.length;
      const before = value.slice(0, atQuery.start);
      let after = value.slice(cursor);
      // Completing inside a quoted token (@"my dir/… with the caret before the
      // closing quote): the replacement carries its own closing quote, so drop
      // the old one right after the caret (mirrors the TUI's applyCompletion).
      if (atQuery.quoted && after.startsWith('"')) {
        after = after.slice(1);
      }
      const insert = buildAtInsertText(entry.path, entry.isDir, atQuery.quoted);
      const newValue = before + insert.text + after;
      const newPos = before.length + insert.cursorOffset;
      setValue(newValue);
      // setValue alone does not fire onChange — re-derive the token here. Files
      // end with a space (token closes, menu hides); directories end with "/"
      // before the caret (token stays open for drill-down into the directory).
      setAtQuery(extractAtQuery(newValue.slice(0, newPos)));
      requestAnimationFrame(() => {
        const el = textareaRef.current;
        if (!el) return;
        el.focus();
        el.setSelectionRange(newPos, newPos);
        el.style.height = "auto";
        el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
      });
    },
    [atQuery, setValue, value],
  );

  useEffect(() => {
    if (atActiveIndex >= atMatches.length) {
      setAtActiveIndex(Math.max(0, atMatches.length - 1));
    }
  }, [atMatches.length, atActiveIndex]);

  useEffect(() => {
    atItemRefs.current.length = atMatches.length;
  }, [atMatches.length]);

  useEffect(() => {
    if (!atMenuOpen) return;
    atItemRefs.current[atActiveIndex]?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [atActiveIndex, atMenuOpen]);

  const applySlashCommand = useCallback(
    (command: SlashCommandPaletteItem) => {
      const nextValue = `/${command.name} `;
      setValue(nextValue);
      setSlashMenuOpen(false);
      setSlashActiveIndex(0);
      requestAnimationFrame(() => {
        const ta = textareaRef.current;
        if (!ta) return;
        ta.focus();
        ta.setSelectionRange(nextValue.length, nextValue.length);
        ta.style.height = "auto";
        ta.style.height = `${Math.min(ta.scrollHeight, 200)}px`;
      });
    },
    [setValue],
  );

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
      const validationRevision = inputRevisionRef.current;
      if (!(await validateLocalFileReferences(attachedFiles))) return;
      if (validationRevision !== inputRevisionRef.current) {
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
      const clearedAtRevision = inputRevisionRef.current;
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
      onAudioUnlock,
      onFollowUp,
      onPromptWithStreamingBehavior,
      onSteer,
      restoreFailedSubmission,
      t,
      validateLocalFileReferences,
      value,
    ],
  );

  const getNextSlashIndex = useCallback(
    (direction: "up" | "down" | "left" | "right") => {
      const lastIndex = filteredSlashCommands.length - 1;
      if (lastIndex < 0) return 0;

      if (direction === "left") return Math.max(0, slashActiveIndex - 1);
      if (direction === "right") return Math.min(lastIndex, slashActiveIndex + 1);

      const currentNode = slashItemRefs.current[slashActiveIndex];
      if (!currentNode) {
        return direction === "down" ? Math.min(lastIndex, slashActiveIndex + 1) : Math.max(0, slashActiveIndex - 1);
      }

      const currentRect = currentNode.getBoundingClientRect();
      const currentX = currentRect.left + currentRect.width / 2;
      const currentY = currentRect.top + currentRect.height / 2;
      let bestIndex = -1;
      let bestScore = Number.POSITIVE_INFINITY;

      for (let index = 0; index <= lastIndex; index += 1) {
        if (index === slashActiveIndex) continue;
        const node = slashItemRefs.current[index];
        if (!node) continue;
        const rect = node.getBoundingClientRect();
        const candidateY = rect.top + rect.height / 2;
        const verticalDelta = candidateY - currentY;
        if (direction === "down" ? verticalDelta <= 4 : verticalDelta >= -4) continue;

        const candidateX = rect.left + rect.width / 2;
        const score = Math.abs(verticalDelta) * 1000 + Math.abs(candidateX - currentX);
        if (score < bestScore) {
          bestIndex = index;
          bestScore = score;
        }
      }

      if (bestIndex >= 0) return bestIndex;
      return direction === "down" ? Math.min(lastIndex, slashActiveIndex + 1) : Math.max(0, slashActiveIndex - 1);
    },
    [filteredSlashCommands.length, slashActiveIndex],
  );

  const handleKeyDown = useCallback(
    (e: KeyboardEvent<HTMLTextAreaElement>) => {
      const nativeEvent = e.nativeEvent;
      const recentlyComposed = Date.now() - lastCompositionEndAtRef.current < COMPOSITION_END_ENTER_GRACE_MS;
      const isComposing = isComposingRef.current || nativeEvent.isComposing || nativeEvent.keyCode === 229;

      if (e.key === "Enter" && !e.shiftKey && (isComposing || recentlyComposed)) {
        if (recentlyComposed) e.preventDefault();
        return;
      }

      if (slashMenuOpen && slashQuery !== null) {
        if (e.key === "ArrowDown") {
          e.preventDefault();
          setSlashActiveIndex(getNextSlashIndex("down"));
          return;
        }
        if (e.key === "ArrowUp") {
          e.preventDefault();
          setSlashActiveIndex(getNextSlashIndex("up"));
          return;
        }
        if (e.key === "ArrowRight") {
          e.preventDefault();
          setSlashActiveIndex(getNextSlashIndex("right"));
          return;
        }
        if (e.key === "ArrowLeft") {
          e.preventDefault();
          setSlashActiveIndex(getNextSlashIndex("left"));
          return;
        }
        if (e.key === "Escape") {
          e.preventDefault();
          setSlashMenuOpen(false);
          return;
        }
        if ((e.key === "Tab" || (e.key === "Enter" && !e.shiftKey)) && filteredSlashCommands[slashActiveIndex]) {
          e.preventDefault();
          applySlashCommand(filteredSlashCommands[slashActiveIndex]);
          return;
        }
      }

      // @ file menu — skip while composing so IME candidate navigation
      // (arrows/Enter/Tab) is never intercepted.
      if (atMenuOpen && atQuery !== null && !isComposing) {
        if (e.key === "ArrowDown") {
          e.preventDefault();
          setAtActiveIndex((i) => Math.min(Math.max(0, atMatches.length - 1), i + 1));
          return;
        }
        if (e.key === "ArrowUp") {
          e.preventDefault();
          setAtActiveIndex((i) => Math.max(0, i - 1));
          return;
        }
        if (e.key === "Escape") {
          e.preventDefault();
          setAtMenuOpen(false);
          return;
        }
        if ((e.key === "Tab" || (e.key === "Enter" && !e.shiftKey)) && atMatches[atActiveIndex]) {
          e.preventDefault();
          applyAtCompletion(atMatches[atActiveIndex]);
          return;
        }
      }

      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        if (isStreaming && (onSteer || onFollowUp)) {
          // Default Enter sends as steer if available, else followup
          void sendQueued(onSteer ? "steer" : "followup");
        } else {
          void handleSend();
        }
      }
    },
    [
      isStreaming,
      onSteer,
      onFollowUp,
      slashMenuOpen,
      slashQuery,
      filteredSlashCommands,
      slashActiveIndex,
      applySlashCommand,
      sendQueued,
      handleSend,
      getNextSlashIndex,
      atMenuOpen,
      atQuery,
      atMatches,
      atActiveIndex,
      applyAtCompletion,
    ],
  );

  const handleInput = useCallback(() => {
    const ta = textareaRef.current;
    if (!ta) return;
    ta.style.height = "auto";
    ta.style.height = `${Math.min(ta.scrollHeight, 200)}px`;
  }, []);

  const handlePaste = useCallback(
    (e: React.ClipboardEvent) => {
      const items = Array.from(e.clipboardData?.items ?? []);
      const fileItems = items.filter((item) => item.kind === "file");
      if (!fileItems.length) return;
      e.preventDefault();
      const files = fileItems.map((item) => item.getAsFile()).filter((f): f is File => f !== null);
      void processFiles(files);
    },
    [processFiles],
  );

  useEffect(() => {
    if (slashQuery === null) {
      setSlashMenuOpen(false);
      setSlashActiveIndex(0);
      slashCommandsRequestedRef.current = false;
      return;
    }
    setSlashMenuOpen(true);
    setSlashActiveIndex(0);
    if (!slashCommandsRequestedRef.current && onLoadSlashCommands) {
      slashCommandsRequestedRef.current = true;
      Promise.resolve(onLoadSlashCommands()).catch(() => {
        slashCommandsRequestedRef.current = false;
      });
    }
  }, [slashQuery, onLoadSlashCommands]);

  useEffect(() => {
    if (slashActiveIndex >= filteredSlashCommands.length) {
      setSlashActiveIndex(Math.max(0, filteredSlashCommands.length - 1));
    }
  }, [filteredSlashCommands.length, slashActiveIndex]);

  useEffect(() => {
    slashItemRefs.current.length = filteredSlashCommands.length;
  }, [filteredSlashCommands.length]);

  useEffect(() => {
    if (!slashMenuOpen) return;
    slashItemRefs.current[slashActiveIndex]?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [slashActiveIndex, slashMenuOpen]);

  // Build model options: prefer modelList (has provider info), fallback to modelNames
  const modelOptions: ModelOption[] = (() => {
    if (modelList && modelList.length > 0) {
      return modelList.map((m) => ({ provider: m.provider, modelId: m.id, name: m.name })).sort(compareModelOptions);
    }
    return Object.entries(modelNames ?? {})
      .map(([modelId, name]) => ({
        provider: model?.provider ?? "unknown",
        modelId,
        name,
      }))
      .sort(compareModelOptions);
  })();

  // Group options by provider, preserving insertion order
  const modelsByProvider: { provider: string; options: ModelOption[] }[] = [];
  for (const opt of modelOptions) {
    const group = modelsByProvider.find((g) => g.provider === opt.provider);
    if (group) group.options.push(opt);
    else modelsByProvider.push({ provider: opt.provider, options: [opt] });
  }

  const displayModelName = model
    ? (modelOptions.find((o) => o.modelId === model.modelId && o.provider === model.provider)?.name ?? model.modelId)
    : null;
  const currentName = displayModelName;

  const compactSavedTokens = compactResult
    ? Math.max(0, compactResult.tokensBefore - compactResult.estimatedTokensAfter)
    : 0;
  const compactVerb =
    compactResult?.reason && compactResult.reason !== "manual"
      ? `${compactResult.reason[0].toUpperCase()}${compactResult.reason.slice(1)} compacted`
      : "Compacted";
  const compactResultText = compactResult
    ? `${compactVerb} ${formatTokenCount(compactResult.tokensBefore)} -> ${formatTokenCount(compactResult.estimatedTokensAfter)} tokens (${formatTokenCount(compactSavedTokens)} saved)`
    : null;
  const thinkingLabels: Record<(typeof THINKING_LEVELS)[number], string> = {
    auto: t("thinkingAuto", "Auto"),
    off: t("thinkingOff", "Off"),
    minimal: t("thinkingMinimal", "Minimal"),
    low: t("thinkingLow", "Low"),
    medium: t("thinkingMedium", "Medium"),
    high: t("thinkingHigh", "High"),
    xhigh: t("thinkingXHigh", "Extra high"),
  };
  const thinkingDescriptions: Record<(typeof THINKING_LEVELS)[number], string> = {
    auto: t("thinkingDefaultDescription", "Use Pi default"),
    off: t("thinkingOffDescription", "Reasoning off"),
    minimal: t("thinkingMinimalDescription", "Minimal reasoning"),
    low: t("thinkingLowDescription", "Low reasoning"),
    medium: t("thinkingMediumDescription", "Medium reasoning"),
    high: t("thinkingHighDescription", "High reasoning"),
    xhigh: t("thinkingXHighDescription", "Max reasoning"),
  };
  const translateThinkingValue = (value: string): string => {
    return (THINKING_LEVELS as readonly string[]).includes(value)
      ? thinkingLabels[value as (typeof THINKING_LEVELS)[number]]
      : value;
  };
  const thinkingDisplayLabel = (() => {
    const lvl = thinkingLevel ?? "auto";
    if (lvl === "auto" || !thinkingLevelMap) return thinkingLabels[lvl];
    return translateThinkingValue(thinkingLevelMap[lvl] ?? lvl);
  })();
  const toolPresetKey =
    (Object.entries(TOOL_PRESET_MAP).find(([, value]) => value === (toolPreset ?? "default"))?.[0] as
      "off" | "default" | "full" | undefined) ?? "default";
  const toolPresetLabels: Record<"off" | "default" | "full", string> = {
    off: t("permissionReadOnly", "Read only"),
    default: t("permissionStandard", "Standard"),
    full: t("permissionFull", "Full access"),
  };
  const toolPresetLabel = toolPresetLabels[toolPresetKey];
  const closeControlDropdowns = useCallback(() => {
    setThinkingDropdownOpen(false);
    setToolDropdownOpen(false);
  }, []);

  const updateModelDropdownRect = useCallback(() => {
    const button = modelButtonRef.current;
    if (!button) return;
    const rect = button.getBoundingClientRect();
    const next = { top: rect.top, left: rect.left, width: rect.width };
    setModelDropdownRect((previous) =>
      previous && previous.top === next.top && previous.left === next.left && previous.width === next.width
        ? previous
        : next,
    );
  }, []);

  // Close dropdowns on outside click
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (
        dropdownRef.current &&
        !dropdownRef.current.contains(e.target as Node) &&
        modelDropdownPanelRef.current &&
        !modelDropdownPanelRef.current.contains(e.target as Node)
      ) {
        setModelDropdownOpen(false);
      }
      if (toolDropdownRef.current && !toolDropdownRef.current.contains(e.target as Node)) {
        setToolDropdownOpen(false);
      }
      if (thinkingDropdownRef.current && !thinkingDropdownRef.current.contains(e.target as Node)) {
        setThinkingDropdownOpen(false);
      }
      if (controlsMenuRef.current && !controlsMenuRef.current.contains(e.target as Node)) {
        closeControlDropdowns();
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [closeControlDropdowns]);

  useEffect(() => {
    closeControlDropdowns();
  }, [closeControlDropdowns, isMobile, isStreaming]);

  const modelDropdownWasOpenRef = useRef(false);
  useEffect(() => {
    if (modelDropdownWasOpenRef.current && !modelDropdownOpen && modelRefreshing) onModelsRefreshCancel?.();
    modelDropdownWasOpenRef.current = modelDropdownOpen;
  }, [modelDropdownOpen, modelRefreshing, onModelsRefreshCancel]);

  useLayoutEffect(() => {
    if (!modelDropdownOpen) return;
    updateModelDropdownRect();

    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(() => updateModelDropdownRect());
    if (modelButtonRef.current) observer?.observe(modelButtonRef.current);
    if (dropdownRef.current?.parentElement) observer?.observe(dropdownRef.current.parentElement);

    const visualViewport = window.visualViewport;
    window.addEventListener("resize", updateModelDropdownRect);
    window.addEventListener("scroll", updateModelDropdownRect, true);
    visualViewport?.addEventListener("resize", updateModelDropdownRect);
    visualViewport?.addEventListener("scroll", updateModelDropdownRect);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", updateModelDropdownRect);
      window.removeEventListener("scroll", updateModelDropdownRect, true);
      visualViewport?.removeEventListener("resize", updateModelDropdownRect);
      visualViewport?.removeEventListener("scroll", updateModelDropdownRect);
    };
  }, [modelDropdownOpen, updateModelDropdownRect]);

  useEffect(() => {
    if (!thinkingDropdownOpen && !toolDropdownOpen) return;
    const handleEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      const restoreThinkingFocus = thinkingDropdownOpen;
      closeControlDropdowns();
      requestAnimationFrame(() => {
        if (restoreThinkingFocus) thinkingButtonRef.current?.focus();
        else toolButtonRef.current?.focus();
      });
    };
    document.addEventListener("keydown", handleEscape, true);
    return () => document.removeEventListener("keydown", handleEscape, true);
  }, [closeControlDropdowns, thinkingDropdownOpen, toolDropdownOpen]);

  return (
    <div
      style={{
        flexShrink: 0,
        background: "transparent",
        padding: "12px 16px",
        paddingRight: isMobile ? 16 : 52, // desktop: 16px base + 36px for ChatMinimap alignment
      }}
    >
      {/* Hidden file input */}
      <input
        ref={fileInputRef}
        type="file"
        multiple
        style={{ display: "none" }}
        onChange={(e) => {
          const files = Array.from(e.target.files ?? []);
          void processFiles(files);
          e.target.value = "";
        }}
      />
      <div className="chat-content-column">
        {/* Queued steering / follow-up messages (delivered by pi on upcoming turns) */}
        {(queuedMessages?.steering.length ?? 0) + (queuedMessages?.followUp.length ?? 0) > 0 && (
          <div
            style={{
              marginBottom: 8,
              border: "1px solid var(--border)",
              borderRadius: 6,
              background: "var(--bg-panel)",
              padding: "5px 0",
            }}
          >
            <div
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                gap: 8,
                padding: "2px 8px 4px 10px",
              }}
            >
              <span
                style={{
                  fontSize: scaledChatFont(10),
                  fontFamily: "var(--font-mono)",
                  color: "var(--text-dim)",
                  textTransform: "uppercase",
                  letterSpacing: 0.4,
                }}
              >
                {t("queued", "Queued")} ·{" "}
                {(queuedMessages?.steering.length ?? 0) + (queuedMessages?.followUp.length ?? 0)}
              </span>
              {onRecallQueue && (
                <button
                  onClick={onRecallQueue}
                  title={t(
                    "recallQueueDescription",
                    "Remove all queued messages and put them back into the input box for editing",
                  )}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 6,
                    padding: "4px 12px",
                    fontSize: scaledChatFont(12),
                    color: "var(--text)",
                    background: "transparent",
                    border: "1px solid var(--border)",
                    borderRadius: 7,
                    cursor: "pointer",
                    transition: "background 0.12s, border-color 0.12s",
                    whiteSpace: "nowrap",
                  }}
                  onMouseEnter={(e) => {
                    e.currentTarget.style.background = "var(--bg-hover)";
                    e.currentTarget.style.borderColor = "color-mix(in srgb, var(--accent) 45%, var(--border))";
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.background = "transparent";
                    e.currentTarget.style.borderColor = "var(--border)";
                  }}
                >
                  <svg
                    width="13"
                    height="13"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <polyline points="9 14 4 9 9 4" />
                    <path d="M20 20v-7a4 4 0 0 0-4-4H4" />
                  </svg>
                  {t("recallToInput", "Recall to input")}
                </button>
              )}
            </div>
            {queuedMessages?.steering.map((text, i) => (
              <QueuedMessageRow key={`steer-${i}`} kind="steer" text={text} />
            ))}
            {queuedMessages?.followUp.map((text, i) => (
              <QueuedMessageRow key={`followup-${i}`} kind="follow-up" text={text} />
            ))}
          </div>
        )}
        {/* Retry banner */}
        {retryInfo && (
          <div
            style={{
              marginBottom: 8,
              padding: "5px 10px",
              background: "rgba(234,179,8,0.08)",
              border: "1px solid rgba(234,179,8,0.25)",
              borderRadius: 6,
              fontSize: scaledChatFont(12),
              color: "rgba(180,130,0,0.9)",
              display: "flex",
              alignItems: "center",
              gap: 6,
            }}
          >
            <svg
              width="11"
              height="11"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              style={{ flexShrink: 0 }}
            >
              <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
              <path d="M3 3v5h5" />
            </svg>
            {t("retrying", "Retrying")} ({retryInfo.attempt}/{retryInfo.maxAttempts})…
            {retryInfo.errorMessage && <span style={{ opacity: 0.7, marginLeft: 4 }}>— {retryInfo.errorMessage}</span>}
          </div>
        )}
        {imageAttachNotice && (
          <div
            role="alert"
            style={{
              marginBottom: 8,
              padding: "5px 10px",
              background: "color-mix(in srgb, var(--danger) 8%, transparent)",
              border: "1px solid color-mix(in srgb, var(--danger) 28%, var(--border))",
              borderRadius: 6,
              fontSize: scaledChatFont(12),
              color: "var(--danger)",
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              gap: 8,
            }}
          >
            <span>{imageAttachNotice}</span>
            <button
              type="button"
              onClick={() => setImageAttachNotice(null)}
              aria-label="Dismiss image attachment error"
              style={{
                border: "none",
                background: "transparent",
                color: "inherit",
                cursor: "pointer",
                padding: 2,
                lineHeight: 1,
              }}
            >
              ×
            </button>
          </div>
        )}
        {submissionNotice && (
          <div
            role="alert"
            data-testid="composer-submission-error"
            style={{
              marginBottom: 8,
              padding: "5px 10px",
              background: "color-mix(in srgb, var(--danger) 8%, transparent)",
              border: "1px solid color-mix(in srgb, var(--danger) 28%, var(--border))",
              borderRadius: 6,
              fontSize: scaledChatFont(12),
              color: "var(--danger)",
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              gap: 8,
            }}
          >
            <span>{submissionNotice}</span>
            <button
              type="button"
              onClick={() => setSubmissionNotice(null)}
              aria-label={t("dismissSubmissionError", "Dismiss submission error")}
              style={{
                border: "none",
                background: "transparent",
                color: "inherit",
                cursor: "pointer",
                padding: 2,
                lineHeight: 1,
              }}
            >
              ×
            </button>
          </div>
        )}
        {compactResultText && (
          <div
            style={{
              marginBottom: 8,
              padding: "5px 10px",
              background: "rgba(16,185,129,0.08)",
              border: "1px solid rgba(16,185,129,0.24)",
              borderRadius: 6,
              fontSize: scaledChatFont(12),
              color: "rgba(5,150,105,0.95)",
              display: "flex",
              alignItems: "center",
              gap: 6,
            }}
          >
            <svg
              width="11"
              height="11"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              style={{ flexShrink: 0 }}
            >
              <polyline points="20 6 9 17 4 12" />
            </svg>
            {compactResultText}
          </div>
        )}
        {/* Image previews */}
        {attachedImages.length > 0 && (
          <div style={{ display: "flex", gap: 6, marginBottom: 6, flexWrap: "wrap" }}>
            {attachedImages.map((img, i) => (
              <div key={i} style={{ position: "relative", flexShrink: 0 }}>
                <img
                  src={img.previewUrl}
                  alt=""
                  style={{
                    width: 56,
                    height: 56,
                    objectFit: "cover",
                    borderRadius: 6,
                    border: "1px solid var(--border)",
                    display: "block",
                  }}
                />
                <button
                  onClick={() => removeImage(i)}
                  style={{
                    position: "absolute",
                    top: -4,
                    right: -4,
                    width: 16,
                    height: 16,
                    borderRadius: "50%",
                    background: "var(--bg-panel)",
                    border: "1px solid var(--border)",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    cursor: "pointer",
                    padding: 0,
                    color: "var(--text-muted)",
                  }}
                >
                  <svg
                    width="8"
                    height="8"
                    viewBox="0 0 8 8"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.5"
                    strokeLinecap="round"
                  >
                    <line x1="1" y1="1" x2="7" y2="7" />
                    <line x1="7" y1="1" x2="1" y2="7" />
                  </svg>
                </button>
              </div>
            ))}
          </div>
        )}

        {/* File attachment chips */}
        {attachedFiles.length > 0 && (
          <div style={{ marginBottom: 6 }}>
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
              {attachedFiles.map((file, i) => (
                <div
                  key={`${file.path}-${i}`}
                  title={`${file.path}${
                    fileInspectionByPath.get(localFilePathKey(file.path))?.insideCwd === false
                      ? ` — ${t("outsideProject", "Outside project")}`
                      : ""
                  }`}
                  onClick={() => void window.piBridge?.showItemInFolder?.(file.path)}
                  onContextMenu={(event) => {
                    event.preventDefault();
                    const request = window.piBridge.showFileContextMenu({
                      href: file.path,
                      cwd: cwd ?? undefined,
                      source: "local-file-reference",
                      language,
                    });
                    void request
                      .then((result) => {
                        if (!result.shown) {
                          setSubmissionNotice(t("fileContextMenuUnavailable", "The file menu could not be opened."));
                        }
                      })
                      .catch(() => {
                        setSubmissionNotice(t("fileContextMenuUnavailable", "The file menu could not be opened."));
                      });
                  }}
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    gap: 6,
                    maxWidth: 260,
                    padding: "4px 6px 4px 8px",
                    borderRadius: 6,
                    border: `1px solid ${
                      fileInspectionByPath.get(localFilePathKey(file.path))?.exists === false
                        ? "var(--danger)"
                        : "var(--border)"
                    }`,
                    background: "var(--bg-panel)",
                    cursor: "pointer",
                    fontSize: scaledChatFont(12),
                  }}
                >
                  <svg
                    width="12"
                    height="12"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    style={{ flexShrink: 0, color: "var(--text-muted)" }}
                  >
                    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                    <polyline points="14 2 14 8 20 8" />
                  </svg>
                  <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {file.name}
                  </span>
                  {fileInspectionByPath.get(localFilePathKey(file.path))?.insideCwd === false && (
                    <span style={{ color: "var(--warning)", fontSize: scaledChatFont(10), whiteSpace: "nowrap" }}>
                      {t("outsideProject", "Outside project")}
                    </span>
                  )}
                  <button
                    onClick={(event) => {
                      event.stopPropagation();
                      removeFile(i);
                    }}
                    title={t("remove", "Remove")}
                    style={{
                      width: 16,
                      height: 16,
                      borderRadius: "50%",
                      background: "transparent",
                      border: "none",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      cursor: "pointer",
                      padding: 0,
                      color: "var(--text-muted)",
                      flexShrink: 0,
                    }}
                  >
                    <svg
                      width="8"
                      height="8"
                      viewBox="0 0 8 8"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.5"
                      strokeLinecap="round"
                    >
                      <line x1="1" y1="1" x2="7" y2="7" />
                      <line x1="7" y1="1" x2="1" y2="7" />
                    </svg>
                  </button>
                </div>
              ))}
            </div>
            <div style={{ marginTop: 4, fontSize: scaledChatFont(10.5), color: "var(--text-dim)" }}>
              {t(
                "localFileDraftPrivacy",
                "Local file paths stay on this device and are saved with this session draft until it is sent or removed.",
              )}
            </div>
          </div>
        )}

        {/* Main input */}
        <div style={{ position: "relative" }}>
          {slashMenuOpen && slashQuery !== null && (
            <div
              style={{
                position: "absolute",
                left: 0,
                right: 0,
                bottom: "calc(100% + 8px)",
                zIndex: 120,
                background: "var(--bg)",
                border: "1px solid var(--border)",
                borderRadius: 8,
                boxShadow: "0 -6px 20px rgba(0,0,0,0.12)",
                overflow: "hidden",
                maxHeight: "min(56vh, 460px)",
              }}
            >
              <div
                style={{
                  padding: "8px 10px",
                  borderBottom: "1px solid var(--border)",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  gap: 8,
                  fontSize: scaledChatFont(11),
                  color: "var(--text-dim)",
                }}
              >
                <span>
                  {slashCommandsLoading
                    ? t("loadingCommands", "Loading commands…")
                    : t("slashCommandsWithCount", "Slash commands · {count}").replace(
                        "{count}",
                        slashCommandCountLabel,
                      )}
                </span>
                <span style={{ fontFamily: "var(--font-mono)" }}>Tab / Enter</span>
              </div>
              <div style={{ maxHeight: "calc(min(56vh, 460px) - 34px)", overflowY: "auto", padding: 10 }}>
                {!slashCommandsLoading && filteredSlashCommands.length === 0 ? (
                  <div style={{ padding: "2px 2px 4px", fontSize: scaledChatFont(12), color: "var(--text-dim)" }}>
                    {t("noSlashCommandsFound", "No extension, prompt, or skill commands found")}
                  </div>
                ) : (
                  groupedSlashCommands.map((group) => (
                    <section key={group.source} style={{ marginBottom: 12 }}>
                      <div
                        style={{
                          position: "sticky",
                          top: -10,
                          zIndex: 1,
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "space-between",
                          gap: 8,
                          padding: "4px 0 6px",
                          background: "var(--bg)",
                          color: "var(--text-dim)",
                          fontSize: scaledChatFont(10),
                          fontWeight: 600,
                          textTransform: "uppercase",
                        }}
                      >
                        <span>{SLASH_SOURCE_GROUP_LABEL[group.source]}</span>
                        <span style={{ fontFamily: "var(--font-mono)", fontWeight: 500 }}>{group.items.length}</span>
                      </div>
                      <div
                        style={{
                          display: "grid",
                          gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
                          gap: 8,
                        }}
                      >
                        {group.items.map(({ command, index }) => {
                          const active = index === slashActiveIndex;
                          return (
                            <button
                              key={`${command.source}:${command.name}`}
                              ref={(node) => {
                                slashItemRefs.current[index] = node;
                              }}
                              type="button"
                              onMouseDown={(e) => {
                                e.preventDefault();
                                applySlashCommand(command);
                              }}
                              onMouseEnter={() => setSlashActiveIndex(index)}
                              style={{
                                width: "100%",
                                minWidth: 0,
                                minHeight: 58,
                                display: "flex",
                                flexDirection: "column",
                                gap: 4,
                                justifyContent: "center",
                                padding: "9px 10px",
                                border: `1px solid ${active ? "var(--accent)" : "var(--border)"}`,
                                borderRadius: 7,
                                background: active ? "var(--bg-selected)" : "var(--bg-panel)",
                                color: "var(--text)",
                                cursor: "pointer",
                                textAlign: "left",
                                boxShadow: active
                                  ? "0 0 0 1px color-mix(in srgb, var(--accent) 28%, transparent)"
                                  : "none",
                              }}
                            >
                              <span
                                style={{
                                  fontSize: scaledChatFont(13),
                                  fontFamily: "var(--font-mono)",
                                  overflowWrap: "anywhere",
                                  wordBreak: "break-word",
                                }}
                              >
                                /{command.name}
                              </span>
                              {command.description && (
                                <span
                                  style={{
                                    display: "-webkit-box",
                                    WebkitBoxOrient: "vertical",
                                    WebkitLineClamp: 2,
                                    overflow: "hidden",
                                    fontSize: scaledChatFont(11),
                                    lineHeight: 1.35,
                                    color: "var(--text-dim)",
                                  }}
                                >
                                  {command.description}
                                </span>
                              )}
                            </button>
                          );
                        })}
                      </div>
                    </section>
                  ))
                )}
              </div>
            </div>
          )}
          {atMenuOpen &&
            atQuery !== null &&
            (() => {
              const suggestionStatus = activeSuggestionState?.status ?? "loading";
              const suggestionsLoading = suggestionStatus === "loading";
              const matchCountLabel =
                atMatches.length === 1
                  ? t("oneMatch", "1 match")
                  : t("matchCount", "{count} matches").replace("{count}", String(atMatches.length));
              const resultHint = activeSuggestionState?.degradedReason
                ? ` · ${t("fileSearchDegraded", "limited to this folder")}`
                : activeSuggestionState?.truncated
                  ? ` · ${t("fileIndexTruncated", "index truncated")}`
                  : "";
              return (
                <div
                  style={{
                    position: "absolute",
                    left: 0,
                    right: 0,
                    bottom: "calc(100% + 8px)",
                    zIndex: 120,
                    background: "var(--bg)",
                    border: "1px solid var(--border)",
                    borderRadius: 8,
                    boxShadow: "0 -6px 20px rgba(0,0,0,0.12)",
                    overflow: "hidden",
                    maxHeight: "min(48vh, 400px)",
                  }}
                >
                  <div
                    aria-live="polite"
                    style={{
                      padding: "8px 10px",
                      borderBottom: "1px solid var(--border)",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "space-between",
                      gap: 8,
                      fontSize: scaledChatFont(11),
                      color: "var(--text-dim)",
                    }}
                  >
                    <span>
                      {suggestionsLoading
                        ? t("loadingProjectFiles", "Loading files…")
                        : `${t("filesAndMatchCount", "Files · {count}").replace(
                            "{count}",
                            matchCountLabel,
                          )}${resultHint}`}
                    </span>
                    <span style={{ fontFamily: "var(--font-mono)" }}>Tab / Enter</span>
                  </div>
                  <div style={{ maxHeight: "calc(min(48vh, 400px) - 34px)", overflowY: "auto", padding: 4 }}>
                    {atMatches.length === 0 ? (
                      <div style={{ padding: "6px 8px", fontSize: scaledChatFont(12), color: "var(--text-dim)" }}>
                        {suggestionsLoading
                          ? t("searching", "Searching…")
                          : suggestionStatus === "error"
                            ? t("fileSuggestionsUnavailable", "File suggestions are temporarily unavailable")
                            : t("noMatchingProjectFiles", "No matching files")}
                      </div>
                    ) : (
                      atMatches.map((entry, index) => {
                        const active = index === atActiveIndex;
                        const name = entry.path.split("/").pop() ?? entry.path;
                        const dirPrefix = entry.path.slice(0, entry.path.length - name.length);
                        return (
                          <button
                            key={`${entry.isDir ? "d" : "f"}:${entry.path}`}
                            ref={(node) => {
                              atItemRefs.current[index] = node;
                            }}
                            type="button"
                            onMouseDown={(e) => {
                              e.preventDefault();
                              applyAtCompletion(entry);
                            }}
                            onMouseEnter={() => setAtActiveIndex(index)}
                            style={{
                              width: "100%",
                              display: "flex",
                              alignItems: "center",
                              gap: 8,
                              padding: "6px 8px",
                              border: "none",
                              borderRadius: 6,
                              background: active ? "var(--bg-selected)" : "none",
                              color: "var(--text)",
                              cursor: "pointer",
                              textAlign: "left",
                              fontSize: scaledChatFont(12.5),
                              fontFamily: "var(--font-mono)",
                            }}
                          >
                            <span style={{ flexShrink: 0, display: "flex", alignItems: "center" }}>
                              {entry.isDir ? <FolderIcon size={14} /> : getFileIcon(name, 14)}
                            </span>
                            <span
                              style={{
                                minWidth: 0,
                                overflow: "hidden",
                                textOverflow: "ellipsis",
                                whiteSpace: "nowrap",
                              }}
                            >
                              {dirPrefix && <span style={{ color: "var(--text-dim)" }}>{dirPrefix}</span>}
                              {name}
                              {entry.isDir && <span style={{ color: "var(--text-dim)" }}>/</span>}
                            </span>
                          </button>
                        );
                      })
                    )}
                  </div>
                </div>
              );
            })()}
          <div
            className="chat-composer-shell"
            style={
              {
                display: "flex",
                gap: 8,
                alignItems: "center",
                background: "var(--assistant-bg)",
                border: `1px solid ${isStreaming && (onSteer || onFollowUp) ? "rgba(234,179,8,0.4)" : "var(--border)"}`,
                borderRadius: 14,
                padding: "10px 10px 10px 12px",
                boxShadow: "0 8px 24px color-mix(in srgb, #000 8%, transparent)",
                transition: "border-color 0.15s, background 0.15s, box-shadow 0.15s",
              } as React.CSSProperties
            }
          >
            <textarea
              ref={textareaRef}
              value={value}
              onChange={(e) => {
                setValue(e.target.value);
                updateAtQuery(e.target.value, e.target.selectionStart);
              }}
              onSelect={(e) => {
                const el = e.currentTarget;
                updateAtQuery(el.value, el.selectionStart);
              }}
              onKeyDown={handleKeyDown}
              onCompositionStart={() => {
                isComposingRef.current = true;
              }}
              onCompositionEnd={(e) => {
                isComposingRef.current = false;
                lastCompositionEndAtRef.current = Date.now();
                const el = e.currentTarget;
                updateAtQuery(el.value, el.selectionStart);
              }}
              onInput={handleInput}
              onPaste={handlePaste}
              placeholder={
                isStreaming && (onSteer || onFollowUp)
                  ? t("steerOrQueue", "Steer now / queue follow-up…")
                  : isStreaming
                    ? t("agentRunning", "Agent is running…")
                    : t("messagePlaceholder", "Message… Type / for commands, @ for files")
              }
              rows={1}
              style={{
                flex: 1,
                background: "none",
                border: "none",
                outline: "none",
                resize: "none",
                color: "var(--text)",
                fontSize: scaledChatFont(14),
                lineHeight: 1.6,
                fontFamily: "inherit",
                minHeight: 24,
                maxHeight: 200,
                overflow: "auto",
              }}
            />

            {isStreaming ? (
              <div style={{ display: "flex", alignItems: "center", gap: 6, flexShrink: 0, alignSelf: "flex-end" }}>
                {onSteer && (
                  <button
                    onClick={() => sendQueued("steer")}
                    disabled={!canQueueStreamingMessage}
                    title={
                      attachedImages.length
                        ? t("imageQueueUnavailable", "Image attachments cannot be queued while the agent is running")
                        : t("steerDescription", "Interrupt the current run and inject this message now")
                    }
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 5,
                      padding: "7px 12px",
                      background: canQueueStreamingMessage ? "rgba(234,179,8,0.12)" : "none",
                      border: "1px solid rgba(234,179,8,0.35)",
                      borderRadius: 8,
                      color: canQueueStreamingMessage ? "rgba(180,130,0,1)" : "var(--text-dim)",
                      cursor: canQueueStreamingMessage ? "pointer" : "not-allowed",
                      fontSize: scaledChatFont(13),
                      fontWeight: 600,
                      letterSpacing: "-0.01em",
                      transition: "background 0.12s",
                    }}
                  >
                    <svg
                      width="12"
                      height="12"
                      viewBox="0 0 10 10"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.8"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    >
                      <path d="M5 1 L9 5 L5 9" />
                      <line x1="1" y1="5" x2="9" y2="5" />
                    </svg>
                    {t("steer", "Steer")}
                  </button>
                )}
                {onFollowUp && (
                  <button
                    onClick={() => sendQueued("followup")}
                    disabled={!canQueueStreamingMessage}
                    title={
                      attachedImages.length
                        ? t("imageQueueUnavailable", "Image attachments cannot be queued while the agent is running")
                        : t("followUpDescription", "Queue this message after the agent finishes")
                    }
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 5,
                      padding: "7px 12px",
                      background: canQueueStreamingMessage ? "rgba(129,140,248,0.12)" : "none",
                      border: "1px solid rgba(129,140,248,0.35)",
                      borderRadius: 8,
                      color: canQueueStreamingMessage ? "rgba(99,102,241,1)" : "var(--text-dim)",
                      cursor: canQueueStreamingMessage ? "pointer" : "not-allowed",
                      fontSize: scaledChatFont(13),
                      fontWeight: 600,
                      letterSpacing: "-0.01em",
                      transition: "background 0.12s",
                    }}
                  >
                    <svg
                      width="12"
                      height="12"
                      viewBox="0 0 10 10"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.8"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    >
                      <line x1="5" y1="1" x2="5" y2="6" />
                      <polyline points="2.5 3.5 5 1 7.5 3.5" />
                      <line x1="2" y1="9" x2="8" y2="9" />
                    </svg>
                    {t("followUp", "Follow-up")}
                  </button>
                )}
              </div>
            ) : (
              <button
                onClick={handleSend}
                disabled={!value.trim() && !attachedImages.length && !attachedFiles.length}
                style={{
                  flexShrink: 0,
                  alignSelf: "flex-end",
                  display: "flex",
                  alignItems: "center",
                  gap: 6,
                  padding: "10px 18px",
                  background:
                    value.trim() || attachedImages.length || attachedFiles.length ? "var(--accent)" : "var(--bg-hover)",
                  border: "none",
                  borderRadius: 9,
                  color:
                    value.trim() || attachedImages.length || attachedFiles.length
                      ? "var(--on-accent)"
                      : "var(--text-dim)",
                  cursor: value.trim() || attachedImages.length || attachedFiles.length ? "pointer" : "not-allowed",
                  fontSize: scaledChatFont(12.5),
                  fontWeight: 700,
                  fontFamily: "var(--font-mono)",
                  letterSpacing: "-0.01em",
                  boxShadow:
                    value.trim() || attachedImages.length || attachedFiles.length
                      ? "0 1px 3px color-mix(in srgb, var(--accent) 30%, transparent)"
                      : "none",
                  transition: "background 0.15s, box-shadow 0.15s",
                }}
              >
                {t("send", "Send")}
              </button>
            )}
          </div>
        </div>

        {/* Bottom bar: left | center (context) | right */}
        <div
          style={{
            marginTop: 8,
            display: isMobile ? "grid" : "flex",
            gridTemplateColumns: isMobile ? "minmax(0, 1fr) auto" : undefined,
            alignItems: "center",
            gap: 6,
          }}
        >
          {/* LEFT: attach + model selector (idle) or steer/followup toggle (streaming) */}
          <div
            style={{
              flex: isMobile ? "1 1 auto" : "0 0 auto",
              minWidth: 0,
              display: "flex",
              alignItems: "center",
              gap: isMobile ? 2 : 6,
            }}
          >
            <button
              onClick={() => fileInputRef.current?.click()}
              title={t(
                "attachLocalFilesDescription",
                "Add images or local file references. The agent reads absolute paths on this computer; moved files, remote agents, or sandboxes may not be able to access them.",
              )}
              aria-label={t("attachLocalFiles", "Add images or local file references")}
              style={{
                flexShrink: 0,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                width: 32,
                height: 32,
                padding: 0,
                background: attachedImages.length || attachedFiles.length ? "var(--accent-soft)" : "var(--bg-panel)",
                border: "1px solid var(--border)",
                borderRadius: 9,
                color: attachedImages.length || attachedFiles.length ? "var(--accent)" : "var(--text-muted)",
                cursor: "pointer",
                opacity: 1,
                transition: "background 0.12s, color 0.12s",
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.background = "var(--bg-hover)";
                e.currentTarget.style.color =
                  attachedImages.length || attachedFiles.length ? "var(--accent)" : "var(--text)";
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.background =
                  attachedImages.length || attachedFiles.length ? "var(--accent-soft)" : "var(--bg-panel)";
                e.currentTarget.style.color =
                  attachedImages.length || attachedFiles.length ? "var(--accent)" : "var(--text-muted)";
              }}
            >
              <svg
                width="15"
                height="15"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
                <circle cx="8.5" cy="8.5" r="1.5" />
                <polyline points="21 15 16 10 5 21" />
              </svg>
            </button>
            {/* Model selector — visible always, disabled during streaming */}
            {(onModelsRefresh || (modelOptions.length > 0 && currentName && onModelChange)) && (
              <div
                ref={dropdownRef}
                style={{ position: "relative", flex: isMobile ? "1 1 auto" : undefined, minWidth: 0 }}
              >
                <button
                  ref={modelButtonRef}
                  onClick={() => {
                    updateModelDropdownRect();
                    setModelDropdownOpen((v) => !v);
                  }}
                  disabled={isStreaming}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 6,
                    justifyContent: isMobile ? "flex-start" : undefined,
                    padding: isMobile ? "8px 10px" : "8px 12px",
                    minHeight: 32,
                    width: isMobile ? "100%" : undefined,
                    maxWidth: isMobile ? "100%" : 220,
                    overflow: "hidden",
                    background: modelDropdownOpen ? "var(--bg-selected)" : "var(--bg-panel)",
                    border: "1px solid var(--border)",
                    borderRadius: 9,
                    color: "var(--text-muted)",
                    cursor: isStreaming ? "not-allowed" : "pointer",
                    fontSize: scaledChatFont(12),
                    opacity: isStreaming ? 0.5 : 1,
                    transition: "background 0.12s, color 0.12s",
                  }}
                  onMouseEnter={(e) => {
                    if (isStreaming) return;
                    e.currentTarget.style.background = "var(--bg-hover)";
                    e.currentTarget.style.color = "var(--text)";
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.background = modelDropdownOpen ? "var(--bg-selected)" : "var(--bg-panel)";
                    e.currentTarget.style.color = "var(--text-muted)";
                  }}
                >
                  <svg
                    width="11"
                    height="11"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <rect x="4" y="4" width="16" height="16" rx="2" />
                    <rect x="9" y="9" width="6" height="6" />
                    <line x1="9" y1="1" x2="9" y2="4" />
                    <line x1="15" y1="1" x2="15" y2="4" />
                    <line x1="9" y1="20" x2="9" y2="23" />
                    <line x1="15" y1="20" x2="15" y2="23" />
                    <line x1="20" y1="9" x2="23" y2="9" />
                    <line x1="20" y1="14" x2="23" y2="14" />
                    <line x1="1" y1="9" x2="4" y2="9" />
                    <line x1="1" y1="14" x2="4" y2="14" />
                  </svg>
                  <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", minWidth: 0 }}>
                    {currentName ?? t("models", "Models")}
                  </span>
                </button>
                {modelDropdownOpen &&
                  modelDropdownRect &&
                  typeof document !== "undefined" &&
                  createPortal(
                    (() => {
                      const viewportHeight = window.visualViewport?.height ?? window.innerHeight;
                      const bottom = viewportHeight - modelDropdownRect.top + 6;
                      const maxH = Math.max(120, Math.min(modelDropdownRect.top - 8, viewportHeight * 0.6));
                      // On mobile, pin to a small left margin and cap width to the
                      // viewport so long model names never push the panel off-screen.
                      const panelPos: React.CSSProperties = isMobile
                        ? { left: 8, right: 8, maxWidth: "calc(100vw - 16px)" }
                        : { left: modelDropdownRect.left, width: "max-content", minWidth: modelDropdownRect.width };
                      return (
                        <div
                          ref={modelDropdownPanelRef}
                          className="chat-appearance-scope"
                          style={{
                            position: "fixed",
                            bottom,
                            ...panelPos,
                            zIndex: 500,
                            background: "var(--bg)",
                            border: "1px solid var(--border)",
                            borderRadius: 8,
                            boxShadow: "0 -4px 16px rgba(0,0,0,0.10)",
                            overflow: "hidden",
                            maxHeight: maxH,
                            overflowY: "auto",
                          }}
                        >
                          {onModelsRefresh && (
                            <div
                              style={{
                                padding: "7px 8px",
                                borderBottom: "1px solid var(--border)",
                                minWidth: 240,
                              }}
                            >
                              <button
                                type="button"
                                disabled={modelRefreshing}
                                onClick={() => void onModelsRefresh?.()}
                                style={{
                                  width: "100%",
                                  padding: "7px 9px",
                                  border: "1px solid var(--border)",
                                  borderRadius: 6,
                                  background: "var(--bg-panel)",
                                  color: "var(--text)",
                                  cursor: modelRefreshing ? "wait" : "pointer",
                                  fontSize: scaledChatFont(12),
                                  textAlign: "left",
                                }}
                              >
                                {modelRefreshing
                                  ? t("refreshingModels", "Refreshing model directory…")
                                  : t("refreshModels", "Refresh model directory")}
                              </button>
                              {modelCatalog?.source === "offline" && (
                                <div style={{ marginTop: 6, color: "var(--text-dim)", fontSize: scaledChatFont(11) }}>
                                  {t("modelsOfflineCache", "Offline: using the cached model directory.")}
                                </div>
                              )}
                              {(modelCatalog?.warnings ?? []).map((warning) => (
                                <div
                                  key={`${warning.provider}:${warning.code}`}
                                  role="alert"
                                  style={{
                                    marginTop: 6,
                                    color: "var(--warning)",
                                    fontSize: scaledChatFont(11),
                                    whiteSpace: "normal",
                                  }}
                                >
                                  {warning.message}
                                </div>
                              ))}
                            </div>
                          )}
                          {modelsByProvider.map((group, gi) => (
                            <div key={group.provider}>
                              {modelsByProvider.length > 1 && (
                                <div
                                  style={{
                                    padding: "6px 12px 4px",
                                    fontSize: scaledChatFont(10),
                                    fontWeight: 600,
                                    color: "var(--text-dim)",
                                    textTransform: "uppercase",
                                    letterSpacing: "0.07em",
                                    borderTop: gi > 0 ? "1px solid var(--border)" : "none",
                                  }}
                                >
                                  {group.provider}
                                </div>
                              )}
                              {group.options.map((opt) => {
                                const isActive = opt.modelId === model?.modelId && opt.provider === model?.provider;
                                return (
                                  <button
                                    key={`${opt.provider}:${opt.modelId}`}
                                    onClick={() => {
                                      setModelDropdownOpen(false);
                                      if (!isActive || isAutoModelSelection) onModelChange?.(opt.provider, opt.modelId);
                                    }}
                                    style={{
                                      display: "flex",
                                      alignItems: "center",
                                      gap: 8,
                                      width: "100%",
                                      padding: "7px 12px",
                                      background: isActive ? "var(--bg-selected)" : "none",
                                      border: "none",
                                      color: isActive ? "var(--text)" : "var(--text-muted)",
                                      cursor: "pointer",
                                      fontSize: scaledChatFont(12),
                                      textAlign: "left",
                                      fontWeight: isActive ? 600 : 400,
                                      whiteSpace: "nowrap",
                                    }}
                                    onMouseEnter={(e) => {
                                      if (!isActive) e.currentTarget.style.background = "var(--bg-hover)";
                                    }}
                                    onMouseLeave={(e) => {
                                      if (!isActive) e.currentTarget.style.background = "none";
                                    }}
                                  >
                                    {isActive ? (
                                      <svg
                                        width="10"
                                        height="10"
                                        viewBox="0 0 10 10"
                                        fill="none"
                                        stroke="var(--accent)"
                                        strokeWidth="2"
                                        strokeLinecap="round"
                                        strokeLinejoin="round"
                                        style={{ flexShrink: 0 }}
                                      >
                                        <polyline points="1.5 5 4 7.5 8.5 2.5" />
                                      </svg>
                                    ) : (
                                      <span style={{ width: 10, flexShrink: 0 }} />
                                    )}
                                    {opt.name}
                                  </button>
                                );
                              })}
                            </div>
                          ))}
                        </div>
                      );
                    })(),
                    document.body,
                  )}
              </div>
            )}
          </div>

          {/* spacer */}
          {!isMobile && <div style={{ flex: 1 }} />}

          {/* RIGHT: reasoning, permissions, compaction, sound, and the streaming stop action. */}
          <div
            ref={controlsMenuRef}
            style={{
              flex: "0 0 auto",
              display: "flex",
              alignItems: "center",
              gap: isMobile ? 2 : 6,
              justifyContent: "flex-end",
              position: "relative",
              marginLeft: isMobile ? 0 : "auto",
            }}
          >
            {isStreaming && (
              <button
                type="button"
                onClick={() => {
                  closeControlDropdowns();
                  onAbort();
                }}
                title={t("stopAgent", "Stop agent")}
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  gap: 6,
                  width: isMobile ? 32 : undefined,
                  padding: isMobile ? 0 : "8px 14px",
                  minHeight: 32,
                  background: "rgba(239,68,68,0.08)",
                  border: "1px solid rgba(239,68,68,0.3)",
                  borderRadius: 9,
                  color: "var(--danger)",
                  cursor: "pointer",
                  fontSize: scaledChatFont(12),
                  fontWeight: 600,
                  whiteSpace: "nowrap",
                  letterSpacing: "-0.01em",
                  transition: "background 0.12s",
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.background = "rgba(239,68,68,0.16)";
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.background = "rgba(239,68,68,0.08)";
                }}
              >
                <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
                  <rect x="1.5" y="1.5" width="7" height="7" rx="1.5" fill="currentColor" />
                </svg>
                {!isMobile && t("stop", "Stop")}
              </button>
            )}
            <div style={{ display: "contents" }}>
              {onThinkingLevelChange && (
                <div ref={thinkingDropdownRef} style={{ position: "relative" }}>
                  <button
                    ref={thinkingButtonRef}
                    type="button"
                    aria-haspopup="menu"
                    aria-expanded={thinkingDropdownOpen}
                    onClick={() => {
                      if (isStreaming) return;
                      setModelDropdownOpen(false);
                      setToolDropdownOpen(false);
                      setThinkingDropdownOpen((v) => !v);
                    }}
                    disabled={isStreaming}
                    title={`${t("changeThinkingLevel", "Change reasoning level")}: ${thinkingDisplayLabel}`}
                    aria-label={`${t("changeThinkingLevel", "Change reasoning level")}: ${thinkingDisplayLabel}`}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      gap: 5,
                      padding: isMobile ? 0 : "0 9px",
                      minWidth: 32,
                      minHeight: 32,
                      background: thinkingDropdownOpen ? "var(--bg-selected)" : "var(--bg-panel)",
                      border: "1px solid var(--border)",
                      borderRadius: 9,
                      color: "var(--text-muted)",
                      cursor: isStreaming ? "not-allowed" : "pointer",
                      fontSize: scaledChatFont(12),
                      opacity: isStreaming ? 0.5 : 1,
                      transition: "background 0.12s, color 0.12s",
                    }}
                    onMouseEnter={(e) => {
                      if (isStreaming) return;
                      e.currentTarget.style.background = "var(--bg-hover)";
                      e.currentTarget.style.color = "var(--text)";
                    }}
                    onMouseLeave={(e) => {
                      e.currentTarget.style.background = thinkingDropdownOpen
                        ? "var(--bg-selected)"
                        : "var(--bg-panel)";
                      e.currentTarget.style.color = "var(--text-muted)";
                    }}
                  >
                    <svg
                      width="11"
                      height="11"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    >
                      <path d="M9.5 2A5.5 5.5 0 0 0 4 7.5c0 1.7.78 3.21 2 4.21V14a1 1 0 0 0 1 1h5a1 1 0 0 0 1-1v-2.29c1.22-1 2-2.51 2-4.21A5.5 5.5 0 0 0 9.5 2z" />
                      <line x1="7" y1="18" x2="12" y2="18" />
                      <line x1="8" y1="21" x2="11" y2="21" />
                    </svg>
                    {!isMobile && <span style={{ whiteSpace: "nowrap" }}>{thinkingDisplayLabel}</span>}
                  </button>
                  {thinkingDropdownOpen && (
                    <div
                      role="menu"
                      aria-label={t("changeThinkingLevel", "Change reasoning level")}
                      style={{
                        position: "absolute",
                        bottom: "calc(100% + 6px)",
                        right: 0,
                        zIndex: 100,
                        background: "var(--bg)",
                        border: "1px solid var(--border)",
                        borderRadius: 8,
                        boxShadow: "0 -4px 16px rgba(0,0,0,0.10)",
                        overflow: "hidden",
                        minWidth: 180,
                      }}
                    >
                      {THINKING_LEVELS.filter((lvl) => {
                        if (!availableThinkingLevels) return true;
                        if (lvl === "auto") return true;
                        return availableThinkingLevels.includes(lvl);
                      }).map((lvl) => {
                        const isActive = (thinkingLevel ?? "auto") === lvl;
                        const desc = thinkingDescriptions[lvl];
                        const mappedVal = lvl !== "auto" && thinkingLevelMap ? thinkingLevelMap[lvl] : undefined;
                        const displayLabel = translateThinkingValue(
                          mappedVal != null && mappedVal !== lvl ? mappedVal : lvl,
                        );
                        const showOriginal = mappedVal != null && mappedVal !== lvl;
                        return (
                          <button
                            key={lvl}
                            type="button"
                            role="menuitemradio"
                            aria-checked={isActive}
                            onClick={() => {
                              if (!isActive) onThinkingLevelChange(lvl);
                              setThinkingDropdownOpen(false);
                              requestAnimationFrame(() => thinkingButtonRef.current?.focus());
                            }}
                            style={{
                              display: "flex",
                              alignItems: "center",
                              gap: 8,
                              width: "100%",
                              padding: "7px 12px",
                              background: isActive ? "var(--bg-selected)" : "none",
                              border: "none",
                              color: isActive ? "var(--text)" : "var(--text-muted)",
                              cursor: "pointer",
                              fontSize: scaledChatFont(12),
                              textAlign: "left",
                              fontWeight: isActive ? 600 : 400,
                              whiteSpace: "nowrap",
                            }}
                            onMouseEnter={(e) => {
                              if (!isActive) e.currentTarget.style.background = "var(--bg-hover)";
                            }}
                            onMouseLeave={(e) => {
                              if (!isActive) e.currentTarget.style.background = "none";
                            }}
                          >
                            {isActive ? (
                              <svg
                                width="10"
                                height="10"
                                viewBox="0 0 10 10"
                                fill="none"
                                stroke="var(--accent)"
                                strokeWidth="2"
                                strokeLinecap="round"
                                strokeLinejoin="round"
                                style={{ flexShrink: 0 }}
                              >
                                <polyline points="1.5 5 4 7.5 8.5 2.5" />
                              </svg>
                            ) : (
                              <span style={{ width: 10, flexShrink: 0 }} />
                            )}
                            <span style={{ flex: 1 }}>
                              {displayLabel}
                              {showOriginal && (
                                <span
                                  style={{
                                    fontSize: scaledChatFont(10),
                                    color: "var(--text-dim)",
                                    fontFamily: "var(--font-mono)",
                                    marginLeft: 5,
                                  }}
                                >
                                  ({thinkingLabels[lvl]})
                                </span>
                              )}
                            </span>
                            <span style={{ fontSize: scaledChatFont(11), color: "var(--text-dim)", marginLeft: 8 }}>
                              {desc}
                            </span>
                          </button>
                        );
                      })}
                    </div>
                  )}
                </div>
              )}
              {onToolPresetChange && (
                <div ref={toolDropdownRef} style={{ position: "relative" }}>
                  <button
                    ref={toolButtonRef}
                    type="button"
                    aria-haspopup="menu"
                    aria-expanded={toolDropdownOpen}
                    onClick={() => {
                      if (isStreaming) return;
                      setModelDropdownOpen(false);
                      setThinkingDropdownOpen(false);
                      setToolDropdownOpen((v) => !v);
                    }}
                    disabled={isStreaming}
                    title={`${t("changePermission", "Change permission settings")}: ${toolPresetLabel}`}
                    aria-label={`${t("changePermission", "Change permission settings")}: ${toolPresetLabel}`}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      gap: 5,
                      padding: isMobile ? 0 : "0 9px",
                      minWidth: 32,
                      minHeight: 32,
                      background: toolDropdownOpen ? "var(--bg-selected)" : "var(--bg-panel)",
                      border: `1px solid ${toolPresetKey === "full" ? "rgba(239,68,68,0.35)" : "var(--border)"}`,
                      borderRadius: 9,
                      color: "var(--text-muted)",
                      cursor: isStreaming ? "not-allowed" : "pointer",
                      fontSize: scaledChatFont(12),
                      opacity: isStreaming ? 0.5 : 1,
                      transition: "background 0.12s, color 0.12s",
                    }}
                    onMouseEnter={(e) => {
                      if (isStreaming) return;
                      e.currentTarget.style.background = "var(--bg-hover)";
                      e.currentTarget.style.color = "var(--text)";
                    }}
                    onMouseLeave={(e) => {
                      e.currentTarget.style.background = toolDropdownOpen ? "var(--bg-selected)" : "var(--bg-panel)";
                      e.currentTarget.style.color = "var(--text-muted)";
                    }}
                  >
                    <svg
                      width="11"
                      height="11"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    >
                      <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z" />
                    </svg>
                    {!isMobile && <span style={{ whiteSpace: "nowrap" }}>{toolPresetLabel}</span>}
                  </button>
                  {toolDropdownOpen && (
                    <div
                      role="menu"
                      aria-label={t("changePermission", "Change permission settings")}
                      style={{
                        position: "absolute",
                        bottom: "calc(100% + 6px)",
                        right: 0,
                        zIndex: 100,
                        background: "var(--bg)",
                        border: "1px solid var(--border)",
                        borderRadius: 8,
                        boxShadow: "0 -4px 16px rgba(0,0,0,0.10)",
                        overflow: "hidden",
                        minWidth: 120,
                      }}
                    >
                      {TOOL_PRESETS.map((lvl) => {
                        const preset = TOOL_PRESET_MAP[lvl];
                        const isActive = (toolPreset ?? "default") === preset;
                        const desc =
                          lvl === "off"
                            ? t("permissionReadOnlyDescription", "No tools, read-only")
                            : lvl === "default"
                              ? t("permissionStandardDescription", "4 built-in tools")
                              : t("permissionFullDescription", "All built-in tools");
                        return (
                          <button
                            key={lvl}
                            type="button"
                            role="menuitemradio"
                            aria-checked={isActive}
                            onClick={() => {
                              if (!isActive) onToolPresetChange(preset);
                              setToolDropdownOpen(false);
                              requestAnimationFrame(() => toolButtonRef.current?.focus());
                            }}
                            style={{
                              display: "flex",
                              alignItems: "center",
                              gap: 8,
                              width: "100%",
                              padding: "7px 12px",
                              background: isActive ? "var(--bg-selected)" : "none",
                              border: "none",
                              color: isActive ? "var(--text)" : "var(--text-muted)",
                              cursor: "pointer",
                              fontSize: scaledChatFont(12),
                              textAlign: "left",
                              fontWeight: isActive ? 600 : 400,
                              whiteSpace: "nowrap",
                            }}
                            onMouseEnter={(e) => {
                              if (!isActive) e.currentTarget.style.background = "var(--bg-hover)";
                            }}
                            onMouseLeave={(e) => {
                              if (!isActive) e.currentTarget.style.background = "none";
                            }}
                          >
                            {isActive ? (
                              <svg
                                width="10"
                                height="10"
                                viewBox="0 0 10 10"
                                fill="none"
                                stroke="var(--accent)"
                                strokeWidth="2"
                                strokeLinecap="round"
                                strokeLinejoin="round"
                                style={{ flexShrink: 0 }}
                              >
                                <polyline points="1.5 5 4 7.5 8.5 2.5" />
                              </svg>
                            ) : (
                              <span style={{ width: 10, flexShrink: 0 }} />
                            )}
                            <span style={{ flex: 1 }}>{toolPresetLabels[lvl]}</span>
                            <span style={{ fontSize: scaledChatFont(11), color: "var(--text-dim)", marginLeft: 8 }}>
                              {desc}
                            </span>
                          </button>
                        );
                      })}
                    </div>
                  )}
                </div>
              )}

              {onCompact && (
                <div style={{ position: "relative" }}>
                  {compactError && (
                    <div
                      style={{
                        position: "absolute",
                        bottom: "calc(100% + 6px)",
                        right: 0,
                        background: "var(--danger-soft)",
                        color: "var(--danger)",
                        fontSize: scaledChatFont(11),
                        padding: "4px 8px",
                        borderRadius: 5,
                        whiteSpace: "nowrap",
                        pointerEvents: "none",
                        boxShadow: "0 2px 8px rgba(0,0,0,0.2)",
                        zIndex: 50,
                      }}
                    >
                      {compactError}
                    </div>
                  )}
                  <button
                    type="button"
                    onClick={() => {
                      closeControlDropdowns();
                      if (isCompacting) onAbortCompaction?.();
                      else onCompact();
                    }}
                    disabled={isStreaming && !isCompacting}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      gap: 5,
                      padding: isMobile ? 0 : "0 9px",
                      minWidth: 32,
                      minHeight: 32,
                      background: isCompacting ? "rgba(239,68,68,0.08)" : "var(--bg-panel)",
                      border: `1px solid ${isCompacting ? "rgba(239,68,68,0.3)" : "var(--border)"}`,
                      borderRadius: 9,
                      color: isCompacting ? "var(--danger)" : "var(--text-muted)",
                      cursor: isStreaming && !isCompacting ? "not-allowed" : "pointer",
                      fontSize: scaledChatFont(12),
                      opacity: isStreaming && !isCompacting ? 0.5 : 1,
                      transition: "background 0.12s, color 0.12s",
                    }}
                    onMouseEnter={(e) => {
                      if (isStreaming && !isCompacting) return;
                      e.currentTarget.style.background = isCompacting ? "rgba(239,68,68,0.16)" : "var(--bg-hover)";
                      e.currentTarget.style.color = isCompacting ? "var(--danger)" : "var(--text)";
                    }}
                    onMouseLeave={(e) => {
                      e.currentTarget.style.background = isCompacting ? "rgba(239,68,68,0.08)" : "var(--bg-panel)";
                      e.currentTarget.style.color = isCompacting ? "var(--danger)" : "var(--text-muted)";
                    }}
                    title={isCompacting ? t("stopCompaction", "Stop compaction") : t("compact", "Compact context")}
                    aria-label={isCompacting ? t("stopCompaction", "Stop compaction") : t("compact", "Compact context")}
                  >
                    {isCompacting ? (
                      <>
                        <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
                          <rect x="2" y="2" width="6" height="6" rx="1" fill="currentColor" />
                        </svg>
                        {!isMobile && <span style={{ whiteSpace: "nowrap" }}>{t("compacting", "Compacting…")}</span>}
                      </>
                    ) : (
                      <>
                        <svg
                          width="11"
                          height="11"
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="2"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                        >
                          <polyline points="4 14 10 14 10 20" />
                          <polyline points="20 10 14 10 14 4" />
                          <line x1="10" y1="14" x2="3" y2="21" />
                          <line x1="21" y1="3" x2="14" y2="10" />
                        </svg>
                        {!isMobile && <span style={{ whiteSpace: "nowrap" }}>{t("compactAction", "Compact")}</span>}
                      </>
                    )}
                  </button>
                </div>
              )}

              {onSoundToggle !== undefined && (
                <button
                  type="button"
                  aria-pressed={soundEnabled === true}
                  onClick={() => {
                    closeControlDropdowns();
                    onSoundToggle();
                  }}
                  title={
                    soundEnabled
                      ? t("disableCompletionSound", "Disable completion sound")
                      : t("enableCompletionSound", "Enable completion sound")
                  }
                  aria-label={
                    soundEnabled
                      ? t("disableCompletionSound", "Disable completion sound")
                      : t("enableCompletionSound", "Enable completion sound")
                  }
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    width: 32,
                    height: 32,
                    padding: 0,
                    background: "var(--bg-panel)",
                    border: "1px solid var(--border)",
                    borderRadius: 9,
                    color: soundEnabled ? "var(--text-muted)" : "var(--text-dim)",
                    cursor: "pointer",
                    opacity: soundEnabled ? 1 : 0.55,
                    transition: "background 0.12s, color 0.12s, opacity 0.12s",
                  }}
                  onMouseEnter={(e) => {
                    e.currentTarget.style.background = "var(--bg-hover)";
                    e.currentTarget.style.color = "var(--text)";
                    e.currentTarget.style.opacity = "1";
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.background = "var(--bg-panel)";
                    e.currentTarget.style.color = soundEnabled ? "var(--text-muted)" : "var(--text-dim)";
                    e.currentTarget.style.opacity = soundEnabled ? "1" : "0.55";
                  }}
                >
                  {soundEnabled ? (
                    <svg
                      width="12"
                      height="12"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    >
                      <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
                      <path d="M15.54 8.46a5 5 0 0 1 0 7.07" />
                      <path d="M19.07 4.93a10 10 0 0 1 0 14.14" />
                    </svg>
                  ) : (
                    <svg
                      width="12"
                      height="12"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    >
                      <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
                      <line x1="23" y1="9" x2="17" y2="15" />
                      <line x1="17" y1="9" x2="23" y2="15" />
                    </svg>
                  )}
                </button>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
});
