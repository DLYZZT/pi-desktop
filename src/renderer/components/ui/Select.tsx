/**
 * Custom single-select listbox replacing native <select> so the popup follows
 * the app theme instead of the OS. The trigger is a Button; the option panel
 * portals to <body> and stays glued to the trigger via usePopoverAnchor.
 *
 * Keyboard model (matches the composer palettes): Enter/Space/ArrowDown/Up
 * open, ArrowUp/Down move across non-disabled options with wrap-around,
 * Home/End jump, Enter commits, Escape/Tab close, outside click closes. The
 * trigger keeps focus while open; aria-activedescendant carries listbox
 * semantics.
 */
import { useCallback, useEffect, useId, useRef, useState, type CSSProperties, type Ref } from "react";
import { createPortal } from "react-dom";
import { Button } from "./Button";
import { ChevronDown } from "lucide-react";
import { usePopoverAnchor } from "./usePopoverAnchor";

export interface SelectOption {
  value: string;
  label: string;
  disabled?: boolean;
}

export type SelectSize = "sm" | "md";

const triggerDensity: Record<SelectSize, CSSProperties> = {
  md: { minHeight: 36, padding: "5px 10px", fontSize: 13 },
  sm: { minHeight: 26, padding: "3px 8px", fontSize: 12 },
};

function normalize(options: readonly (string | SelectOption)[]): SelectOption[] {
  return options.map((o) => (typeof o === "string" ? { value: o, label: o } : o));
}

function moveIndex(index: number, delta: number, options: SelectOption[]): number {
  const count = options.length;
  if (!count) return index;
  let next = index;
  do {
    next = (next + delta + count) % count;
  } while (options[next].disabled && next !== index);
  return next;
}

export interface SelectProps {
  value: string;
  onChange: (v: string) => void;
  options: readonly (string | SelectOption)[];
  /** Trigger text when the value matches no option (e.g. the empty "inherit" slot). */
  placeholder?: string;
  disabled?: boolean;
  /** Density preset; md is the settings-form row height paired with Input's default. */
  size?: SelectSize;
  /** Goes on the trigger so a Field label can associate with it. */
  id?: string;
  autoFocus?: boolean;
  className?: string;
  style?: CSSProperties;
  "aria-label"?: string;
  /** React 19 ref prop, forwarded to the trigger button. */
  ref?: Ref<HTMLButtonElement>;
}

export function Select({
  value,
  onChange,
  options,
  placeholder,
  disabled,
  size = "md",
  id,
  autoFocus,
  className,
  style,
  "aria-label": ariaLabel,
  ref,
}: SelectProps) {
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const activeIndexRef = useRef(0);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const { anchorRef, rect, update } = usePopoverAnchor<HTMLButtonElement>(open);
  const listId = useId();
  // Portaled panels must render inside the nearest modal dialog: body-level
  // portals stack below a modal backdrop (fixed, high z-index) and become both
  // dimmed and click-intercepted. Detected once per open since dialogs mount
  // before their content can be interacted with.
  const [portalContainer, setPortalContainer] = useState<HTMLElement | null>(null);

  const normalized = normalize(options);
  const selected = normalized.find((o) => o.value === value);
  const triggerLabel = selected ? selected.label : (placeholder ?? value);

  const openList = useCallback(() => {
    if (disabled) return;
    const anchor = anchorRef.current;
    setPortalContainer((anchor?.closest('[role="dialog"][aria-modal="true"]') as HTMLElement | null) ?? document.body);
    const index = normalized.findIndex((o) => o.value === value);
    const start = index >= 0 ? index : 0;
    setActiveIndex(start);
    activeIndexRef.current = start;
    update();
    setOpen(true);
  }, [disabled, normalized, value, update, anchorRef]);

  const commit = useCallback(
    (option: SelectOption) => {
      if (option.disabled) return;
      onChange(option.value);
      setOpen(false);
    },
    [onChange],
  );

  // The anchor must carry both the hook's tracking ref and the caller's ref.
  const setAnchor = useCallback(
    (node: HTMLButtonElement | null) => {
      anchorRef.current = node;
      if (typeof ref === "function") ref(node);
      else if (ref) ref.current = node;
    },
    [anchorRef, ref],
  );

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      const options_ = normalize(options);
      if (event.key === "Escape") {
        event.preventDefault();
        setOpen(false);
      } else if (event.key === "ArrowDown") {
        event.preventDefault();
        setActiveIndex((current) => {
          const next = moveIndex(current, 1, options_);
          activeIndexRef.current = next;
          return next;
        });
      } else if (event.key === "ArrowUp") {
        event.preventDefault();
        setActiveIndex((current) => {
          const next = moveIndex(current, -1, options_);
          activeIndexRef.current = next;
          return next;
        });
      } else if (event.key === "Home") {
        event.preventDefault();
        let first = 0;
        while (first < options_.length - 1 && options_[first].disabled) first++;
        setActiveIndex(first);
        activeIndexRef.current = first;
      } else if (event.key === "End") {
        event.preventDefault();
        let last = options_.length - 1;
        while (last > 0 && options_[last].disabled) last--;
        setActiveIndex(last);
        activeIndexRef.current = last;
      } else if (event.key === "Enter") {
        event.preventDefault();
        const option = options_[activeIndexRef.current];
        if (option && !option.disabled) {
          onChange(option.value);
          setOpen(false);
        }
      } else if (event.key === "Tab") {
        setOpen(false);
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, options, onChange]);

  useEffect(() => {
    if (!open) return;
    const onDown = (event: MouseEvent) => {
      const target = event.target as Node | null;
      if (!target) return;
      if (panelRef.current?.contains?.(target)) return;
      if (anchorRef.current?.contains?.(target)) return;
      setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open, anchorRef]);

  const viewportHeight = typeof window !== "undefined" ? (window.visualViewport?.height ?? window.innerHeight) : 800;
  const panelStyle: CSSProperties | undefined = rect
    ? (() => {
        const spaceBelow = viewportHeight - rect.bottom - 8;
        const spaceAbove = rect.top - 12;
        const openUp = spaceBelow < 180 && spaceAbove > spaceBelow;
        const maxHeight = Math.max(120, Math.min(openUp ? spaceAbove : spaceBelow, viewportHeight * 0.6));
        return openUp
          ? {
              position: "fixed",
              bottom: viewportHeight - rect.top + 4,
              left: rect.left,
              minWidth: rect.width,
              maxHeight,
            }
          : { position: "fixed", top: rect.bottom + 4, left: rect.left, minWidth: rect.width, maxHeight };
      })()
    : undefined;

  return (
    <>
      <Button
        ref={setAnchor}
        type="button"
        id={id}
        autoFocus={autoFocus}
        disabled={disabled}
        className={className}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-label={ariaLabel}
        onClick={() => (open ? setOpen(false) : openList())}
        onKeyDown={(event) => {
          if (open) return;
          if (event.key === "ArrowDown" || event.key === "ArrowUp" || event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            openList();
          }
        }}
        style={{
          ...triggerDensity[size],
          justifyContent: "space-between",
          gap: 6,
          textAlign: "left",
          ...style,
        }}
      >
        <span
          style={{
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            minWidth: 0,
            color: selected ? "var(--text)" : "var(--text-dim)",
          }}
        >
          {triggerLabel}
        </span>
        <ChevronDown size={10} strokeWidth={1.6} aria-hidden="true" style={{ flexShrink: 0 }} />
      </Button>
      {open &&
        rect &&
        typeof document !== "undefined" &&
        createPortal(
          <div
            ref={panelRef}
            role="listbox"
            id={listId}
            aria-label={ariaLabel}
            tabIndex={-1}
            style={{
              ...panelStyle,
              overflowY: "auto",
              overscrollBehavior: "contain",
              zIndex: 500,
              background: "var(--bg)",
              border: "1px solid var(--border)",
              borderRadius: 7,
              boxShadow: "0 6px 20px rgba(0,0,0,0.10)",
              padding: 3,
            }}
          >
            {normalized.map((option, index) => (
              <div
                key={option.value}
                role="option"
                // Machine-readable value: smoke/E2E drivers select by contract
                // value, not by the localized label text.
                data-value={option.value}
                aria-selected={option.value === value}
                aria-disabled={option.disabled || undefined}
                ref={(node) => {
                  if (index === activeIndex) node?.scrollIntoView?.({ block: "nearest" });
                }}
                onClick={() => commit(option)}
                onMouseMove={() => {
                  setActiveIndex(index);
                  activeIndexRef.current = index;
                }}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 7,
                  minHeight: 28,
                  padding: "4px 9px",
                  borderRadius: 5,
                  cursor: option.disabled ? "default" : "pointer",
                  textAlign: "left",
                  fontSize: size === "sm" ? 12 : 13,
                  background: index === activeIndex ? "var(--bg-hover)" : undefined,
                  color: option.disabled ? "var(--text-dim)" : option.value === value ? "var(--text)" : undefined,
                  fontWeight: option.value === value ? 600 : undefined,
                  whiteSpace: "nowrap",
                }}
              >
                <span style={{ width: 12, flexShrink: 0, color: "var(--accent)" }}>
                  {option.value === value ? "✓" : ""}
                </span>
                {option.label}
              </div>
            ))}
          </div>,
          portalContainer ?? document.body,
        )}
    </>
  );
}
