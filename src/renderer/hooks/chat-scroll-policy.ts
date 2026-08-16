export const CHAT_BOTTOM_PROXIMITY_PX = 96;
export const USER_SCROLL_UP_MIN_PX = 1;

export interface ScrollMetrics {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
  /** Height of the trailing full-viewport run spacer, if present. */
  spacerHeight?: number;
}

export function isNearChatBottom(metrics: ScrollMetrics, threshold = CHAT_BOTTOM_PROXIMITY_PX): boolean {
  if (metrics.clientHeight <= 0) return true;
  // The active-run spacer inflates scrollHeight by one viewport; the real
  // content ends spacerHeight above the raw scroll bottom.
  const contentHeight = metrics.scrollHeight - Math.max(0, metrics.spacerHeight ?? 0);
  const distance = contentHeight - metrics.clientHeight - metrics.scrollTop;
  return distance <= Math.max(0, threshold);
}

export function didUserScrollUp(previousScrollTop: number, currentScrollTop: number): boolean {
  return currentScrollTop < previousScrollTop - USER_SCROLL_UP_MIN_PX;
}

export interface AutoFollowStopInput {
  previousScrollTop: number;
  currentScrollTop: number;
  now: number;
  userIntentUntil: number;
  programmaticScrollUntil: number;
  externalAutoFollow: boolean;
}

export function shouldStopChatAutoFollow(input: AutoFollowStopInput): boolean {
  if (input.now > input.userIntentUntil) return false;
  if (input.now < input.programmaticScrollUntil && !input.externalAutoFollow) return false;
  return didUserScrollUp(input.previousScrollTop, input.currentScrollTop);
}
