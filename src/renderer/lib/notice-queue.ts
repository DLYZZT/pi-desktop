export const MAX_VISIBLE_NOTICES = 5;
export const NOTICE_VISIBLE_MS = 5_000;

export type NoticeType = "info" | "success" | "warning" | "error";

export type NoticeItem = {
  id: string;
  message: string;
  type: NoticeType;
  expiresAt: number;
  exiting?: boolean;
};

export type NoticeState = {
  visible: NoticeItem[];
  pending: NoticeItem[];
};

export type NoticeAction =
  { type: "add"; notice: NoticeItem } | { type: "mark_oldest_exiting" } | { type: "remove"; id: string; now: number };

function markOldestNoticeExiting(notices: NoticeItem[]): NoticeItem[] {
  const index = notices.findIndex((notice) => !notice.exiting);
  if (index === -1) return notices;
  return notices.map((notice, i) => (i === index ? { ...notice, exiting: true } : notice));
}

function fillPendingNotices(visible: NoticeItem[], pending: NoticeItem[], now: number): NoticeState {
  let nextVisible = visible;
  let nextPending = pending;
  while (nextPending.length > 0 && nextVisible.length < MAX_VISIBLE_NOTICES) {
    const [next, ...rest] = nextPending;
    nextVisible = [...nextVisible, { ...next, expiresAt: now + NOTICE_VISIBLE_MS }];
    nextPending = rest;
  }
  if (nextPending.length > 0 && !nextVisible.some((notice) => notice.exiting)) {
    nextVisible = markOldestNoticeExiting(nextVisible);
  }
  return { visible: nextVisible, pending: nextPending };
}

export function noticeReducer(state: NoticeState, action: NoticeAction): NoticeState {
  switch (action.type) {
    case "add": {
      if (state.visible.some((notice) => notice.exiting) || state.visible.length >= MAX_VISIBLE_NOTICES) {
        return {
          visible: state.visible.some((notice) => notice.exiting)
            ? state.visible
            : markOldestNoticeExiting(state.visible),
          pending: [...state.pending, action.notice],
        };
      }
      return { ...state, visible: [...state.visible, action.notice] };
    }
    case "mark_oldest_exiting":
      return { ...state, visible: markOldestNoticeExiting(state.visible) };
    case "remove": {
      const visible = state.visible.filter((notice) => notice.id !== action.id);
      return fillPendingNotices(visible, state.pending, action.now);
    }
    default:
      return state;
  }
}

export function noticeExpiryDelay(notice: NoticeItem, now: number): number {
  return Math.max(0, notice.expiresAt - now);
}
