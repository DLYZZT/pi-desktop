import { ComposerToolbar, type ComposerToolbarOptions } from "./composer/ComposerToolbar";
import { useComposerDraft } from "@/hooks/useComposerDraft";
import { useComposerSubmission, type ComposerActions } from "@/hooks/useComposerSubmission";
import React, { useRef, useState, useCallback, useEffect, useImperativeHandle, forwardRef, KeyboardEvent } from "react";
import { scaledChatFont } from "@/lib/chat-appearance";
import type { CompactResultInfo, QueuedMessages, SlashCommandInfo } from "@/hooks/useAgentSession";
import { buildAtInsertText, extractAtQuery, type AtQueryMatch, type FileIndexEntry } from "@/lib/file-fuzzy";
import { useFileSuggestions } from "@/hooks/useFileSuggestions";
import { FolderIcon, getFileIcon } from "./FileIcons";
import { useIsMobile } from "@/hooks/useIsMobile";
import { useI18n } from "@/i18n";
import { localFilePathKey, splitLocalFileReferenceMarkdown } from "@/lib/file-url";

export type { AttachedImage } from "@/hooks/useComposerDraft";

interface Props extends ComposerActions, ComposerToolbarOptions {
  compactResult?: CompactResultInfo | null;
  retryInfo?: { attempt: number; maxAttempts: number; errorMessage?: string } | null;
  queuedMessages?: QueuedMessages | null;
  onRecallQueue?: () => void;
  slashCommands?: SlashCommandInfo[];
  slashCommandsLoading?: boolean;
  onLoadSlashCommands?: () => Promise<SlashCommandInfo[]> | SlashCommandInfo[];
  draftKey?: string;
  /** Explicit temporary owner to carry forward when this view receives its real session ID. */
  draftPromotionFrom?: string;
  /** Session working directory — enables the @ file autocomplete menu */
  cwd?: string | null;
}

export interface ChatInputHandle {
  insertText: (text: string) => void;
  insertIfEmpty: (text: string) => void;
  prependText: (text: string) => void;
  addFiles: (files: File[]) => void;
}

const COMPOSITION_END_ENTER_GRACE_MS = 100;
const SLASH_COMMAND_COLLATOR = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

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

const ChatInputComponent = forwardRef<ChatInputHandle, Props>(function ChatInput(
  {
    onSend,
    onSteer,
    onFollowUp,
    isStreaming,
    compactResult,
    retryInfo,
    queuedMessages,
    onRecallQueue,
    slashCommands,
    slashCommandsLoading,
    onLoadSlashCommands,
    onBuiltinCommand,
    onAudioUnlock,
    onPromptWithStreamingBehavior,
    draftKey,
    draftPromotionFrom,
    cwd,
    ...toolbarOptions
  }: Props,
  ref,
) {
  const isMobile = useIsMobile();
  const { t, language } = useI18n();
  const [slashMenuOpen, setSlashMenuOpen] = useState(false);
  const [slashActiveIndex, setSlashActiveIndex] = useState(0);
  const [atQuery, setAtQuery] = useState<AtQueryMatch | null>(null);
  const [atMenuOpen, setAtMenuOpen] = useState(false);
  const [atActiveIndex, setAtActiveIndex] = useState(0);

  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const openAttachmentPicker = useCallback(() => fileInputRef.current?.click(), []);
  const isComposingRef = useRef(false);
  const lastCompositionEndAtRef = useRef(0);
  const slashCommandsRequestedRef = useRef(false);
  const slashItemRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const atItemRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const resetAtQuery = useCallback(() => setAtQuery(null), []);
  const draft = useComposerDraft({ draftKey, draftPromotionFrom, cwd, onReplace: resetAtQuery });
  const {
    value,
    setValue,
    attachedImages,
    attachedFiles,
    fileInspectionByPath,
    imageAttachNotice,
    setImageAttachNotice,
    submissionNotice,
    setSubmissionNotice,
    processFiles,
    removeImage,
    removeFile,
    clearDraft,
  } = draft;
  const clearInput = useCallback(() => {
    clearDraft();
    setAtQuery(null);
    if (textareaRef.current) textareaRef.current.style.height = "auto";
  }, [clearDraft]);

  const { handleSend, sendQueued } = useComposerSubmission({
    draft,
    clearInput,
    isStreaming,
    onSend,
    onSteer,
    onFollowUp,
    onPromptWithStreamingBehavior,
    onBuiltinCommand,
    onAudioUnlock,
  });

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

  useEffect(() => {
    const ta = textareaRef.current;
    if (!ta) return;
    ta.style.height = "auto";
    if (value) ta.style.height = `${Math.min(ta.scrollHeight, 200)}px`;
  }, [value]);

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
          SLASH_SOURCE_ORDER[a.source] - SLASH_SOURCE_ORDER[b.source] || SLASH_COMMAND_COLLATOR.compare(a.name, b.name)
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

  const { tokenKey: atTokenKey, state: activeSuggestionState, matches: atMatches } = useFileSuggestions(cwd, atQuery);

  // A changed token reopens the menu; Escape closes it until the next edit.
  useEffect(() => {
    if (atTokenKey === null) {
      setAtMenuOpen(false);
      setAtActiveIndex(0);
      return;
    }
    setAtMenuOpen(true);
    setAtActiveIndex(0);
  }, [atTokenKey]);

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

        <ComposerToolbar
          options={{ ...toolbarOptions, isStreaming }}
          isMobile={isMobile}
          hasAttachments={attachedImages.length > 0 || attachedFiles.length > 0}
          onAttach={openAttachmentPicker}
        />
      </div>
    </div>
  );
});

export const ChatInput = React.memo(ChatInputComponent);
