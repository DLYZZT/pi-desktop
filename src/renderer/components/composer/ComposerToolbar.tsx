import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { ModelCatalogStatus } from "@contract/types";
import { useI18n } from "@/i18n";
import { scaledChatFont } from "@/lib/chat-appearance";
import type { ToolPreset, SelectableToolPreset } from "@shared/tool-presets";
import {
  THINKING_LEVELS as REASONING_LEVELS,
  thinkingMenuLevels,
  type ThinkingLevelOption,
} from "@shared/thinking-levels";

interface ModelOption {
  provider: string;
  modelId: string;
  name: string;
}

export interface ComposerToolbarOptions {
  onAbort: () => void;
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
  toolPreset?: ToolPreset;
  onToolPresetChange?: (preset: SelectableToolPreset) => void;
  thinkingLevel?: ThinkingLevelOption;
  onThinkingLevelChange?: (level: ThinkingLevelOption) => void;
  availableThinkingLevels?: string[] | null;
  thinkingLevelMap?: Record<string, string | null> | null;
  soundEnabled?: boolean;
  onSoundToggle?: () => void;
}

const TOOL_PRESETS = ["off", "default", "full"] as const;
const TOOL_PRESET_MAP: Record<"off" | "default" | "full", "none" | "default" | "full"> = {
  off: "none",
  default: "default",
  full: "full",
};
const MODEL_OPTION_COLLATOR = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

function compareModelOptions(a: ModelOption, b: ModelOption): number {
  return (
    MODEL_OPTION_COLLATOR.compare(a.name || a.modelId, b.name || b.modelId) ||
    MODEL_OPTION_COLLATOR.compare(a.provider, b.provider) ||
    MODEL_OPTION_COLLATOR.compare(a.modelId, b.modelId)
  );
}

const THINKING_LEVELS = ["auto", ...REASONING_LEVELS] as const;

/** Local menu placement, dismissal and focus ownership for the composer controls. */
function ComposerToolbarView({
  options,
  isMobile,
  hasAttachments,
  onAttach,
}: {
  options: ComposerToolbarOptions;
  isMobile: boolean;
  hasAttachments: boolean;
  onAttach: () => void;
}) {
  const { t } = useI18n();
  const {
    onAbort,
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
    toolPreset,
    onToolPresetChange,
    thinkingLevel,
    onThinkingLevelChange,
    availableThinkingLevels,
    thinkingLevelMap,
    soundEnabled,
    onSoundToggle,
  } = options;
  const [modelDropdownOpen, setModelDropdownOpen] = useState(false);
  const [modelDropdownRect, setModelDropdownRect] = useState<{ top: number; left: number; width: number } | null>(null);
  const [toolDropdownOpen, setToolDropdownOpen] = useState(false);
  const [thinkingDropdownOpen, setThinkingDropdownOpen] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const modelButtonRef = useRef<HTMLButtonElement>(null);
  const modelDropdownPanelRef = useRef<HTMLDivElement>(null);
  const toolDropdownRef = useRef<HTMLDivElement>(null);
  const thinkingDropdownRef = useRef<HTMLDivElement>(null);
  const controlsMenuRef = useRef<HTMLDivElement>(null);
  const thinkingButtonRef = useRef<HTMLButtonElement>(null);
  const toolButtonRef = useRef<HTMLButtonElement>(null);
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

  const thinkingLabels: Record<(typeof THINKING_LEVELS)[number], string> = {
    auto: t("thinkingAuto", "Auto"),
    off: t("thinkingOff", "Off"),
    minimal: t("thinkingMinimal", "Minimal"),
    low: t("thinkingLow", "Low"),
    medium: t("thinkingMedium", "Medium"),
    high: t("thinkingHigh", "High"),
    xhigh: t("thinkingXHigh", "Extra high"),
    max: t("thinkingMax", "Maximum"),
  };
  const thinkingDescriptions: Record<(typeof THINKING_LEVELS)[number], string> = {
    auto: t("thinkingDefaultDescription", "Use Pi default"),
    off: t("thinkingOffDescription", "Reasoning off"),
    minimal: t("thinkingMinimalDescription", "Minimal reasoning"),
    low: t("thinkingLowDescription", "Low reasoning"),
    medium: t("thinkingMediumDescription", "Medium reasoning"),
    high: t("thinkingHighDescription", "High reasoning"),
    xhigh: t("thinkingXHighDescription", "Extra-high reasoning"),
    max: t("thinkingMaxDescription", "Maximum reasoning"),
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
    toolPreset === "custom"
      ? "custom"
      : ((Object.entries(TOOL_PRESET_MAP).find(([, value]) => value === (toolPreset ?? "default"))?.[0] as
          "off" | "default" | "full" | undefined) ?? "default");
  const toolPresetLabels: Record<"off" | "default" | "full" | "custom", string> = {
    off: t("permissionReadOnly", "Read only"),
    default: t("permissionStandard", "Standard"),
    full: t("permissionFull", "Full access"),
    custom: t("permissionCustom", "Custom"),
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
          onClick={onAttach}
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
            background: hasAttachments ? "var(--accent-soft)" : "var(--bg-panel)",
            border: "1px solid var(--border)",
            borderRadius: 9,
            color: hasAttachments ? "var(--accent)" : "var(--text-muted)",
            cursor: "pointer",
            opacity: 1,
            transition: "background 0.12s, color 0.12s",
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.background = "var(--bg-hover)";
            e.currentTarget.style.color = hasAttachments ? "var(--accent)" : "var(--text)";
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.background = hasAttachments ? "var(--accent-soft)" : "var(--bg-panel)";
            e.currentTarget.style.color = hasAttachments ? "var(--accent)" : "var(--text-muted)";
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
          <div ref={dropdownRef} style={{ position: "relative", flex: isMobile ? "1 1 auto" : undefined, minWidth: 0 }}>
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
                  e.currentTarget.style.background = thinkingDropdownOpen ? "var(--bg-selected)" : "var(--bg-panel)";
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
                  {thinkingMenuLevels(availableThinkingLevels).map((lvl) => {
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
                          : t(
                              "permissionFullDescription",
                              "All tools, code orchestration, image generation, classification and search",
                            );
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
  );
}

export const ComposerToolbar = memo(ComposerToolbarView, (previous, next) => {
  if (
    previous.isMobile !== next.isMobile ||
    previous.hasAttachments !== next.hasAttachments ||
    previous.onAttach !== next.onAttach
  )
    return false;
  const keys = Object.keys(previous.options) as (keyof ComposerToolbarOptions)[];
  return (
    keys.length === Object.keys(next.options).length &&
    keys.every((key) => Object.is(previous.options[key], next.options[key]))
  );
});
