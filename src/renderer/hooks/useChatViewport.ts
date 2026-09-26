import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import type { AgentPhase, StreamingState } from "../lib/session-turn-state";
import {
  isNearChatBottom,
  isUpwardScrollKey,
  isUpwardTouchGesture,
  shouldDisengageScrollMagnet,
  shouldStopChatAutoFollow,
} from "./chat-scroll-policy";

// Module-level scroll magnet: survives ChatWindow remounts (each session switch
// uses key={sessionKey} in AppShell, which would otherwise wipe every useRef).
let scrollMagnetEngaged = false;
function getScrollMagnetEngaged(): boolean {
  return scrollMagnetEngaged;
}
function setScrollMagnetEngaged(value: boolean): void {
  scrollMagnetEngaged = value;
}
const PROGRAMMATIC_SCROLL_IGNORE_MS = 700;
const USER_SCROLL_INTENT_MS = 1200;

/** Near-bottom check that ignores the full-viewport run spacer. */
function isNearBottomExcludingSpacer(container: HTMLElement): boolean {
  const spacer = container.querySelector<HTMLElement>("[data-run-spacer]");
  return isNearChatBottom({
    scrollTop: container.scrollTop,
    scrollHeight: container.scrollHeight,
    clientHeight: container.clientHeight,
    spacerHeight: spacer ? spacer.offsetHeight : 0,
  });
}
const SCROLL_KEYS = new Set(["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " ", "Space", "Spacebar"]);

export interface ChatViewportOptions {
  agentRunning: boolean;
  agentRunningRef: RefObject<boolean>;
  agentPhase: AgentPhase;
  streamState: StreamingState;
  messageCount: number;
  loading: boolean;
}

/** Owns DOM anchors, user scroll intent and all follow/restore subscriptions for one chat view. */
export function useChatViewport({
  agentRunning,
  agentRunningRef,
  agentPhase,
  streamState,
  messageCount,
  loading,
}: ChatViewportOptions) {
  // True when the chat viewport has scrolled away from the bottom; drives the
  // floating "scroll to bottom" affordance in ChatWindow.
  const [isAwayFromBottom, setIsAwayFromBottom] = useState(false);

  const initialScrollDoneRef = useRef(false);
  const lastUserMsgRef = useRef<HTMLDivElement | null>(null);
  const pendingScrollToUserRef = useRef(false);
  const pendingHistoryPrependRef = useRef(false);
  const completionScrollAllowedRef = useRef(true);
  const userScrollIntentUntilRef = useRef(0);
  const ignoreProgrammaticScrollUntilRef = useRef(0);
  const messagesEndRef = useRef<HTMLDivElement | null>(null);
  const liveContentEndRef = useRef<HTMLDivElement | null>(null);
  const scrollContainerRef = useRef<HTMLDivElement | null>(null);
  const lastScrollTopRef = useRef(0);
  const touchStartClientYRef = useRef<number | null>(null);
  const externalTurnAutoFollowRef = useRef(false);
  // Set when the user explicitly re-attaches the viewport to the newest
  // content (clicks "scroll to bottom"); live-follow then stays engaged until
  // the user scrolls away again or the run ends.
  // Restored from the module flag so the magnet survives session switches that
  // remount ChatWindow (key={sessionKey}).
  const autoFollowMagnetRef = useRef(getScrollMagnetEngaged());
  const sessionChangeIgnoreScrollUntilRef = useRef(0);
  const activeRef = useRef(true);
  const interactionRevisionRef = useRef(0);
  const restoreFramesRef = useRef(new Set<number>());
  const disposeViewport = useCallback(() => {
    activeRef.current = false;
    interactionRevisionRef.current++;
    for (const frame of restoreFramesRef.current) cancelAnimationFrame(frame);
    restoreFramesRef.current.clear();
  }, []);
  useEffect(() => {
    activeRef.current = true;
    return disposeViewport;
  }, [disposeViewport]);

  const beginLocalTurn = useCallback(() => {
    if (!activeRef.current) return;
    interactionRevisionRef.current++;
    pendingScrollToUserRef.current = true;
    completionScrollAllowedRef.current = true;
  }, []);
  const beginExternalTurn = useCallback(() => {
    if (!activeRef.current) return;
    const container = scrollContainerRef.current;
    const shouldFollow = container ? isNearBottomExcludingSpacer(container) : true;
    externalTurnAutoFollowRef.current = shouldFollow;
    completionScrollAllowedRef.current = shouldFollow;
    if (container) lastScrollTopRef.current = container.scrollTop;
  }, []);
  const endExternalTurn = useCallback(() => {
    externalTurnAutoFollowRef.current = false;
  }, []);
  const prepareSessionChange = useCallback(() => {
    sessionChangeIgnoreScrollUntilRef.current = Date.now() + 1500;
  }, []);
  const scheduleRestore = useCallback((callback: () => void) => {
    if (!activeRef.current) return;
    const pending: { frame?: number; completed: boolean } = { completed: false };
    pending.frame = requestAnimationFrame(() => {
      pending.completed = true;
      if (pending.frame !== undefined) restoreFramesRef.current.delete(pending.frame);
      if (activeRef.current) callback();
    });
    if (!pending.completed) restoreFramesRef.current.add(pending.frame);
  }, []);
  const restoreFollowAfterLoad = useCallback(() => {
    if (!activeRef.current || !autoFollowMagnetRef.current) return;
    const snap = () => {
      if (!autoFollowMagnetRef.current) return;
      const element = agentRunningRef.current ? liveContentEndRef.current : messagesEndRef.current;
      element?.scrollIntoView({ behavior: "auto", block: "end" });
    };
    scheduleRestore(snap);
    scheduleRestore(() => scheduleRestore(snap));
  }, [agentRunningRef, scheduleRestore]);
  const capturePrependAnchor = useCallback(() => {
    if (!activeRef.current) return;
    pendingHistoryPrependRef.current = true;
    const element = scrollContainerRef.current;
    if (!element) return;
    const height = element.scrollHeight;
    const top = element.scrollTop;
    const run = interactionRevisionRef.current;
    const userIntent = userScrollIntentUntilRef.current;
    const localJumpPending = pendingScrollToUserRef.current;
    return () => {
      if (
        !activeRef.current ||
        scrollContainerRef.current !== element ||
        interactionRevisionRef.current !== run ||
        localJumpPending ||
        pendingScrollToUserRef.current ||
        userScrollIntentUntilRef.current !== userIntent
      )
        return;
      ignoreProgrammaticScrollUntilRef.current = Date.now() + PROGRAMMATIC_SCROLL_IGNORE_MS;
      element.scrollTop = top + element.scrollHeight - height;
    };
  }, []);
  const scrollToBottom = useCallback(
    (behavior: ScrollBehavior = "smooth") => {
      if (!activeRef.current) return;
      ignoreProgrammaticScrollUntilRef.current = Date.now() + PROGRAMMATIC_SCROLL_IGNORE_MS;
      // Prefer the live-content end anchor. When the agent is running there is
      // a full-viewport spacer below it (see ChatWindow), and messagesEndRef
      // sits AFTER that spacer — scrolling to it lands in blank footer space
      // with the real content still above the fold.
      const el = agentRunningRef.current ? liveContentEndRef.current : messagesEndRef.current;
      el?.scrollIntoView({ behavior, block: "end" });
    },
    [agentRunningRef],
  );

  const scrollLiveContentToBottom = useCallback(() => {
    if (!activeRef.current) return;
    ignoreProgrammaticScrollUntilRef.current = Date.now() + PROGRAMMATIC_SCROLL_IGNORE_MS;
    liveContentEndRef.current?.scrollIntoView({ behavior: "auto", block: "end" });
  }, []);

  const scrollUserMsgToTop = useCallback(() => {
    if (!activeRef.current) return;
    const container = scrollContainerRef.current;
    const el = lastUserMsgRef.current;
    if (!container || !el) return;
    const elAbsTop = el.getBoundingClientRect().top - container.getBoundingClientRect().top + container.scrollTop;
    ignoreProgrammaticScrollUntilRef.current = Date.now() + PROGRAMMATIC_SCROLL_IGNORE_MS;
    container.scrollTo({ top: elAbsTop - 16, behavior: "smooth" });
  }, []);

  const updateScrollPresence = useCallback(() => {
    if (!activeRef.current) return;
    const container = scrollContainerRef.current;
    if (!container) return;
    const nearBottom = isNearBottomExcludingSpacer(container);
    // Bail out of re-renders when the value is unchanged.
    setIsAwayFromBottom((prev) => (prev === !nearBottom ? prev : !nearBottom));
  }, []);

  // "Scroll to bottom": snap to the end and re-magnet the viewport so the next
  // streaming ticks keep following until the user scrolls away again.
  const reattachAutoFollow = useCallback(() => {
    if (!activeRef.current) return;
    interactionRevisionRef.current++;
    pendingHistoryPrependRef.current = false;
    completionScrollAllowedRef.current = true;
    externalTurnAutoFollowRef.current = false;
    autoFollowMagnetRef.current = true;
    setScrollMagnetEngaged(true);
    pendingScrollToUserRef.current = false;
    initialScrollDoneRef.current = true;
    userScrollIntentUntilRef.current = 0;
    scrollToBottom("auto");
  }, [scrollToBottom]);

  const disengageAutoFollowForExplicitUpwardGesture = useCallback(() => {
    if (!activeRef.current) return;
    completionScrollAllowedRef.current = false;
    externalTurnAutoFollowRef.current = false;
    autoFollowMagnetRef.current = false;
    setScrollMagnetEngaged(false);
  }, []);

  const markUserScrollIntent = useCallback(
    (event: Event) => {
      if (!activeRef.current) return;
      if (event instanceof KeyboardEvent) {
        if (!SCROLL_KEYS.has(event.key)) return;
        if (
          event.target instanceof Element &&
          event.target.closest("input, textarea, [contenteditable]:not([contenteditable='false'])")
        )
          return;
      }
      interactionRevisionRef.current++;
      const container = scrollContainerRef.current;
      if (container) lastScrollTopRef.current = container.scrollTop;
      userScrollIntentUntilRef.current = Date.now() + USER_SCROLL_INTENT_MS;

      // Explicit upward gestures release the follow magnet immediately. Waiting
      // for scroll-position deltas loses during streaming: every follow frame
      // refreshes the programmatic-scroll guard, so a small user scroll-up gets
      // swallowed and the view snaps back down.
      const isUpwardGesture =
        (event instanceof WheelEvent && event.deltaY < 0 && !event.ctrlKey) || // ctrl+wheel = pinch-zoom, not scroll
        (event instanceof KeyboardEvent && isUpwardScrollKey(event.key));
      if (isUpwardGesture) disengageAutoFollowForExplicitUpwardGesture();
    },
    [disengageAutoFollowForExplicitUpwardGesture],
  );

  const handleTouchStart = useCallback(
    (event: TouchEvent) => {
      touchStartClientYRef.current = event.touches[0]?.clientY ?? null;
      markUserScrollIntent(event);
    },
    [markUserScrollIntent],
  );

  const handleTouchMove = useCallback(
    (event: TouchEvent) => {
      const currentClientY = event.touches[0]?.clientY;
      if (currentClientY === undefined || !isUpwardTouchGesture(touchStartClientYRef.current, currentClientY)) return;
      markUserScrollIntent(event);
      disengageAutoFollowForExplicitUpwardGesture();
      touchStartClientYRef.current = currentClientY;
    },
    [disengageAutoFollowForExplicitUpwardGesture, markUserScrollIntent],
  );

  const handleTouchEnd = useCallback(() => {
    touchStartClientYRef.current = null;
  }, []);

  const handleScrollPositionChange = useCallback(() => {
    if (!activeRef.current) return;
    const container = scrollContainerRef.current;
    if (!container) return;
    const previousScrollTop = lastScrollTopRef.current;
    const currentScrollTop = container.scrollTop;
    lastScrollTopRef.current = currentScrollTop;
    updateScrollPresence();
    if (!agentRunningRef.current) {
      // Idle upward movement normally disengages the magnet so the next run
      // does not unexpectedly resume auto-follow. During session transitions,
      // the policy filters synthetic movement but still accepts explicit user
      // input. Scrolling back to the bottom re-engages the magnet.
      const now = Date.now();
      if (
        shouldDisengageScrollMagnet({
          previousScrollTop,
          currentScrollTop,
          now,
          userIntentUntil: userScrollIntentUntilRef.current,
          sessionChangeIgnoreUntil: sessionChangeIgnoreScrollUntilRef.current,
        })
      ) {
        autoFollowMagnetRef.current = false;
        setScrollMagnetEngaged(false);
      } else if (now >= sessionChangeIgnoreScrollUntilRef.current && isNearBottomExcludingSpacer(container)) {
        autoFollowMagnetRef.current = true;
        setScrollMagnetEngaged(true);
      }
      return;
    }
    const now = Date.now();
    // Local prompts deliberately move the user's message to the top; retain
    // the old programmatic-scroll guard for that path. During external
    // auto-follow, explicit upward input must win even while follow frames are
    // producing their own scroll events.
    if (
      shouldStopChatAutoFollow({
        previousScrollTop,
        currentScrollTop,
        now,
        userIntentUntil: userScrollIntentUntilRef.current,
        programmaticScrollUntil: ignoreProgrammaticScrollUntilRef.current,
        externalAutoFollow: externalTurnAutoFollowRef.current,
      })
    ) {
      completionScrollAllowedRef.current = false;
      externalTurnAutoFollowRef.current = false;
      // shouldStopChatAutoFollow only accepts explicit user intent, so it must
      // win even while a session-transition guard is active.
      autoFollowMagnetRef.current = false;
      setScrollMagnetEngaged(false);
    }
  }, [agentRunningRef, updateScrollPresence]);

  useEffect(() => {
    window.addEventListener("keydown", markUserScrollIntent);
    window.addEventListener("pointerdown", markUserScrollIntent, { passive: true });
    return () => {
      window.removeEventListener("keydown", markUserScrollIntent);
      window.removeEventListener("pointerdown", markUserScrollIntent);
    };
  }, [markUserScrollIntent]);

  useEffect(() => {
    const container = scrollContainerRef.current;
    if (!container) return;
    container.addEventListener("wheel", markUserScrollIntent, { passive: true });
    container.addEventListener("touchstart", handleTouchStart, { passive: true });
    container.addEventListener("touchmove", handleTouchMove, { passive: true });
    container.addEventListener("touchend", handleTouchEnd, { passive: true });
    container.addEventListener("touchcancel", handleTouchEnd, { passive: true });
    container.addEventListener("scroll", handleScrollPositionChange, { passive: true });
    return () => {
      container.removeEventListener("wheel", markUserScrollIntent);
      container.removeEventListener("touchstart", handleTouchStart);
      container.removeEventListener("touchmove", handleTouchMove);
      container.removeEventListener("touchend", handleTouchEnd);
      container.removeEventListener("touchcancel", handleTouchEnd);
      container.removeEventListener("scroll", handleScrollPositionChange);
    };
  }, [
    messageCount,
    loading,
    handleScrollPositionChange,
    markUserScrollIntent,
    handleTouchStart,
    handleTouchMove,
    handleTouchEnd,
  ]);

  useEffect(() => {
    if (messageCount > 0) {
      const prepended = pendingHistoryPrependRef.current;
      pendingHistoryPrependRef.current = false;
      if (pendingScrollToUserRef.current) {
        pendingScrollToUserRef.current = false;
        initialScrollDoneRef.current = true;
        scrollUserMsgToTop();
      } else if (prepended && initialScrollDoneRef.current) {
        // A prepend has its own viewport anchor; completion-follow would undo it.
        return;
      } else if (!initialScrollDoneRef.current) {
        initialScrollDoneRef.current = true;
        scrollToBottom("instant");
      } else if (!agentRunningRef.current && completionScrollAllowedRef.current) {
        scrollToBottom("smooth");
      }
    }
  }, [messageCount, agentRunning, agentRunningRef, scrollToBottom, scrollUserMsgToTop]);

  useEffect(() => {
    if (!agentRunning || !completionScrollAllowedRef.current) return;
    if (!externalTurnAutoFollowRef.current && !autoFollowMagnetRef.current) return;
    const frame = requestAnimationFrame(() => {
      if (!completionScrollAllowedRef.current) return;
      if (!externalTurnAutoFollowRef.current && !autoFollowMagnetRef.current) return;
      if (Date.now() <= userScrollIntentUntilRef.current) return;
      scrollLiveContentToBottom();
    });
    return () => cancelAnimationFrame(frame);
  }, [
    agentRunning,
    agentPhase,
    messageCount,
    isAwayFromBottom,
    scrollLiveContentToBottom,
    streamState.streamingMessage,
  ]);

  // Keep "away from bottom" fresh when the viewport or message layout changes.
  useEffect(() => {
    const container = scrollContainerRef.current;
    if (!container) return;
    const ro = new ResizeObserver(() => updateScrollPresence());
    ro.observe(container);
    // scrollHeight can change without resizing the viewport (for example when
    // an image loads or process details expand), so observe the content too.
    const content = liveContentEndRef.current?.parentElement;
    if (content) ro.observe(content);
    updateScrollPresence();
    return () => ro.disconnect();
  }, [loading, messageCount, updateScrollPresence]);

  // Content can grow without firing a scroll event (the streaming tail makes
  // the container taller while scrollTop stays put) — re-evaluate presence
  // after messages/streaming change.
  useEffect(() => {
    const t = setTimeout(updateScrollPresence, 30);
    return () => clearTimeout(t);
  }, [messageCount, streamState.isStreaming, streamState.streamingMessage, updateScrollPresence]);

  return {
    isAwayFromBottom,
    reattachAutoFollow,
    capturePrependAnchor,
    beginLocalTurn,
    beginExternalTurn,
    endExternalTurn,
    prepareSessionChange,
    restoreFollowAfterLoad,
    messagesEndRef,
    liveContentEndRef,
    scrollContainerRef,
    lastUserMsgRef,
    pendingScrollToUserRef,
    initialScrollDoneRef,
  };
}
