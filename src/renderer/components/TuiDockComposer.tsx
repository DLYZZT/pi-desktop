import { useEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent } from "react";
import { FluentProvider, Textarea, webDarkTheme, webLightTheme } from "@fluentui/react-components";
import type { ModelInfo, ModelsListResult } from "@contract/types";
import { listModels } from "@/lib/api-client";
import type { SkillRecord } from "@/lib/api-types";
import type { SessionInfo } from "@/lib/types";
import { applySlashPrefix, extractSlashQuery, filterSlashItems, type SlashQueryMatch } from "@/lib/slash-command";
import { ChangeSessionCwd } from "./ChangeSessionCwd";
import { EMPTY_DOCK_CHROME, parseChromeModel, thinkingCycleSteps, type DockChrome } from "./tui-dock-rect";

const FALLBACK_THINKING = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

type SkillChoice = {
  name: string;
  description: string;
};

function skillChoice(skill: SkillRecord): SkillChoice {
  return { name: `skill:${skill.name}`, description: skill.description };
}

export function TuiDockComposer({
  theme,
  cwd,
  sessionId,
  sessionPath,
  onRelocated,
  chrome = EMPTY_DOCK_CHROME,
  worktreeAnchorRef,
  disabled,
  onSend,
  onSelectModel,
  onSelectThinking,
  onHideCover,
  style,
}: {
  theme: "light" | "dark";
  cwd?: string;
  sessionId?: string;
  sessionPath?: string;
  onRelocated?: (session: SessionInfo) => void;
  chrome?: DockChrome;
  worktreeAnchorRef?: (node: HTMLDivElement | null) => void;
  disabled?: boolean;
  onSend: (text: string) => void;
  onSelectModel?: (provider: string, id: string) => void;
  onSelectThinking?: (steps: number) => void;
  onHideCover?: () => void;
  style?: CSSProperties;
}) {
  const [value, setValue] = useState("");
  const [slashMatch, setSlashMatch] = useState<SlashQueryMatch | null>(null);
  const [slashIndex, setSlashIndex] = useState(0);
  const [skills, setSkills] = useState<SkillChoice[]>([]);
  const [skillsCwd, setSkillsCwd] = useState<string | null>(null);
  const [skillsLoading, setSkillsLoading] = useState(false);
  const [catalog, setCatalog] = useState<ModelsListResult | null>(null);
  const [openMenu, setOpenMenu] = useState<null | "model" | "thinking">(null);
  const modelMenuRef = useRef<HTMLDivElement>(null);
  const thinkingMenuRef = useRef<HTMLDivElement>(null);

  const currentModel = parseChromeModel(chrome.model);
  const modelLabel = currentModel?.id ?? chrome.model;
  const thinkingLevels =
    currentModel && catalog?.thinkingLevels[`${currentModel.provider}:${currentModel.id}`]?.length
      ? catalog.thinkingLevels[`${currentModel.provider}:${currentModel.id}`]
      : FALLBACK_THINKING;

  const syncSlash = (text: string, cursor: number | null) => {
    const pos = cursor ?? text.length;
    setSlashMatch(extractSlashQuery(text.slice(0, pos)));
  };

  useEffect(() => {
    if (!cwd || slashMatch === null || skillsCwd === cwd) return;
    const ac = new AbortController();
    setSkillsLoading(true);
    void fetch(`/api/skills?cwd=${encodeURIComponent(cwd)}`, { signal: ac.signal })
      .then(async (response) => {
        const data = (await response.json()) as { skills?: SkillRecord[] };
        if (!response.ok) throw new Error("skills.list failed");
        setSkills((data.skills ?? []).map(skillChoice));
        setSkillsCwd(cwd);
      })
      .catch((error: unknown) => {
        if (ac.signal.aborted) return;
        console.error("Failed to load skills:", error);
        setSkills([]);
        setSkillsCwd(cwd);
      })
      .finally(() => {
        if (!ac.signal.aborted) setSkillsLoading(false);
      });
    return () => ac.abort();
  }, [cwd, slashMatch, skillsCwd]);

  useEffect(() => {
    if (!cwd) return;
    let cancelled = false;
    void listModels(cwd)
      .then((result) => {
        if (!cancelled) setCatalog(result);
      })
      .catch((error: unknown) => {
        if (!cancelled) console.error("Failed to load models:", error);
      });
    return () => {
      cancelled = true;
    };
  }, [cwd]);

  useEffect(() => {
    if (!openMenu) return;
    const onDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (modelMenuRef.current?.contains(target) || thinkingMenuRef.current?.contains(target)) return;
      setOpenMenu(null);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [openMenu]);

  const slashItems = useMemo(() => {
    if (!slashMatch) return [];
    return filterSlashItems(skills, slashMatch.query);
  }, [skills, slashMatch]);

  useEffect(() => {
    setSlashIndex(0);
  }, [slashMatch?.query, slashItems.length]);

  const applySkill = (item: SkillChoice) => {
    if (!slashMatch) return;
    const next = applySlashPrefix(value, slashMatch, item.name);
    setValue(next);
    setSlashMatch(null);
  };

  const submit = () => {
    const text = value.trim();
    if (!text || disabled) return;
    onSend(text);
    setValue("");
    setSlashMatch(null);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    syncSlash(event.currentTarget.value, event.currentTarget.selectionStart);
    if (slashMatch && slashItems.length > 0) {
      if (event.key === "ArrowDown") {
        event.preventDefault();
        setSlashIndex((index) => Math.min(slashItems.length - 1, index + 1));
        return;
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        setSlashIndex((index) => Math.max(0, index - 1));
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        setSlashMatch(null);
        return;
      }
      if ((event.key === "Tab" || (event.key === "Enter" && !event.shiftKey)) && slashItems[slashIndex]) {
        event.preventDefault();
        applySkill(slashItems[slashIndex]);
        return;
      }
    }
    if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return;
    event.preventDefault();
    submit();
  };

  return (
    <FluentProvider
      theme={theme === "dark" ? webDarkTheme : webLightTheme}
      className="embedded-pi-tui-dock"
      style={{
        pointerEvents: "auto",
        background: "var(--bg-panel)",
        zIndex: 20,
        flex: 1,
        display: "flex",
        minHeight: 0,
        ...style,
      }}
    >
      <div className="embedded-pi-tui-dock-sheet">
        {slashMatch && (
          <div className="tui-dock-slash">
            <div className="tui-dock-slash-head">
              <span>{skillsLoading ? "Loading skills..." : `Skills · ${slashItems.length}`}</span>
              <span>Tab / Enter</span>
            </div>
            <div className="tui-dock-slash-list">
              {!skillsLoading && slashItems.length === 0 ? (
                <div className="tui-dock-slash-empty">No matching skills</div>
              ) : (
                slashItems.map((item, index) => (
                  <button
                    key={item.name}
                    type="button"
                    className={index === slashIndex ? "tui-dock-slash-item is-active" : "tui-dock-slash-item"}
                    onMouseDown={(event) => {
                      event.preventDefault();
                      applySkill(item);
                    }}
                  >
                    <span className="tui-dock-slash-name">/{item.name}</span>
                    {item.description && <span className="tui-dock-slash-desc">{item.description}</span>}
                  </button>
                ))
              )}
            </div>
          </div>
        )}
        <Textarea
          appearance="outline"
          resize="vertical"
          disabled={disabled}
          value={value}
          onChange={(event, data) => {
            setValue(data.value);
            const cursor =
              event.target instanceof HTMLTextAreaElement ? event.target.selectionStart : data.value.length;
            syncSlash(data.value, cursor);
          }}
          onKeyUp={(event) => {
            if (event.currentTarget instanceof HTMLTextAreaElement) {
              syncSlash(event.currentTarget.value, event.currentTarget.selectionStart);
            }
          }}
          onClick={(event) => {
            if (event.target instanceof HTMLTextAreaElement) {
              syncSlash(event.target.value, event.target.selectionStart);
            }
          }}
          onKeyDown={onKeyDown}
          textarea={{ rows: 1 }}
          style={{ width: "100%" }}
        />
        <div className="tui-dock-bar">
          {cwd && sessionId && onRelocated && (
            <ChangeSessionCwd
              cwd={cwd}
              sessionId={sessionId}
              sessionPath={sessionPath}
              onRelocated={onRelocated}
              appearance="pill"
              menuPlacement="up"
            />
          )}
          <div ref={worktreeAnchorRef} className="tui-dock-worktree" />
          {chrome.usage && (
            <span className="tui-dock-usage" title={chrome.usage}>
              {chrome.usage}
            </span>
          )}
          {chrome.model && (
            <div ref={modelMenuRef} className="tui-dock-pick">
              <button
                type="button"
                className="tui-dock-pill"
                title="Select model"
                aria-haspopup="listbox"
                aria-expanded={openMenu === "model"}
                onClick={() => setOpenMenu((menu) => (menu === "model" ? null : "model"))}
              >
                <span className="tui-dock-pill-label">{modelLabel}</span>
                <svg
                  className="tui-dock-pill-chev"
                  width="10"
                  height="10"
                  viewBox="0 0 10 10"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.6"
                >
                  <path d="M2 3.5 5 6.5 8 3.5" />
                </svg>
              </button>
              {openMenu === "model" && (
                <div className="tui-dock-pick-menu" role="listbox" aria-label="Models">
                  {(catalog?.models ?? []).map((model: ModelInfo) => {
                    const active = currentModel?.provider === model.provider && currentModel.id === model.id;
                    return (
                      <button
                        key={`${model.provider}/${model.id}`}
                        type="button"
                        role="option"
                        aria-selected={active}
                        className={active ? "tui-dock-pick-item is-active" : "tui-dock-pick-item"}
                        onClick={() => {
                          setOpenMenu(null);
                          if (!active) onSelectModel?.(model.provider, model.id);
                        }}
                      >
                        <span className="tui-dock-pick-name">{model.name || model.id}</span>
                        <span className="tui-dock-pick-meta">{model.provider}</span>
                      </button>
                    );
                  })}
                  {!catalog?.models.length && <div className="tui-dock-slash-empty">No models</div>}
                </div>
              )}
            </div>
          )}
          {chrome.thinking && (
            <div ref={thinkingMenuRef} className="tui-dock-pick">
              <button
                type="button"
                className="tui-dock-pill"
                title="Select thinking"
                aria-haspopup="listbox"
                aria-expanded={openMenu === "thinking"}
                onClick={() => setOpenMenu((menu) => (menu === "thinking" ? null : "thinking"))}
              >
                <span className="tui-dock-pill-label">{chrome.thinking}</span>
                <svg
                  className="tui-dock-pill-chev"
                  width="10"
                  height="10"
                  viewBox="0 0 10 10"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.6"
                >
                  <path d="M2 3.5 5 6.5 8 3.5" />
                </svg>
              </button>
              {openMenu === "thinking" && (
                <div className="tui-dock-pick-menu" role="listbox" aria-label="Thinking">
                  {thinkingLevels.map((level) => {
                    const active = chrome.thinking === level;
                    return (
                      <button
                        key={level}
                        type="button"
                        role="option"
                        aria-selected={active}
                        className={active ? "tui-dock-pick-item is-active" : "tui-dock-pick-item"}
                        onClick={() => {
                          setOpenMenu(null);
                          if (!chrome.thinking || active) return;
                          const steps = thinkingCycleSteps(chrome.thinking, level, thinkingLevels);
                          if (steps > 0) onSelectThinking?.(steps);
                        }}
                      >
                        {level}
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          )}
          {chrome.statuses.map((status) => (
            <span key={status} className="tui-dock-stat" title={status}>
              {status}
            </span>
          ))}
          {onHideCover && (
            <button type="button" className="tui-dock-pill" title="Show original TUI" onClick={onHideCover}>
              <span className="tui-dock-pill-label">TUI</span>
            </button>
          )}
        </div>
      </div>
    </FluentProvider>
  );
}
