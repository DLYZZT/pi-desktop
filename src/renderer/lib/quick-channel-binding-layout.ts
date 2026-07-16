const VIEWPORT_GUTTER = 12;
const TRIGGER_GAP = 8;
const DESKTOP_WIDTH = 370;
const MOBILE_WIDTH = 340;
const MAX_HEIGHT = 440;
const MIN_BOTTOM_SPACE = 160;

export interface QuickChannelBindingTriggerRect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface QuickChannelBindingPopoverLayoutInput {
  trigger: QuickChannelBindingTriggerRect;
  viewportWidth: number;
  viewportHeight: number;
  isMobile: boolean;
}

export interface QuickChannelBindingPopoverLayout {
  left: number;
  top: number;
  width: number;
  maxHeight: number;
  placement: "top" | "bottom";
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), Math.max(min, max));
}

export function getQuickChannelBindingPopoverLayout({
  trigger,
  viewportWidth,
  viewportHeight,
  isMobile,
}: QuickChannelBindingPopoverLayoutInput): QuickChannelBindingPopoverLayout {
  const safeViewportWidth = Math.max(0, viewportWidth);
  const safeViewportHeight = Math.max(0, viewportHeight);
  const width = Math.min(isMobile ? MOBILE_WIDTH : DESKTOP_WIDTH, Math.max(0, safeViewportWidth - VIEWPORT_GUTTER * 2));
  const maximumLeft = safeViewportWidth - VIEWPORT_GUTTER - width;
  const preferredLeft = isMobile ? (safeViewportWidth - width) / 2 : trigger.right - width;
  const left = clamp(preferredLeft, VIEWPORT_GUTTER, maximumLeft);

  const spaceBelow = Math.max(0, safeViewportHeight - VIEWPORT_GUTTER - trigger.bottom - TRIGGER_GAP);
  const spaceAbove = Math.max(0, trigger.top - TRIGGER_GAP - VIEWPORT_GUTTER);
  const placement = spaceBelow < MIN_BOTTOM_SPACE && spaceAbove > spaceBelow ? "top" : "bottom";
  const maxHeight = Math.min(MAX_HEIGHT, placement === "top" ? spaceAbove : spaceBelow);
  const top =
    placement === "top"
      ? Math.max(VIEWPORT_GUTTER, trigger.top - TRIGGER_GAP - maxHeight)
      : clamp(trigger.bottom + TRIGGER_GAP, VIEWPORT_GUTTER, safeViewportHeight - VIEWPORT_GUTTER);

  return { left, top, width, maxHeight, placement };
}
