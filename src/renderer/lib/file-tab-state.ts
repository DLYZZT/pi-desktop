export interface FileTab {
  id: string;
  label: string;
  filePath: string;
  sourceSessionId?: string | null;
}

export interface FileTabState {
  tabs: FileTab[];
  activeTabId: string;
}

export type FileTabAction =
  | { type: "open"; tab: FileTab }
  | { type: "select"; tabId: string }
  | { type: "close"; tabId: string; fallbackTabId: string };

export function reduceFileTabState(state: FileTabState, action: FileTabAction): FileTabState {
  if (action.type === "select") {
    return state.activeTabId === action.tabId ? state : { ...state, activeTabId: action.tabId };
  }

  if (action.type === "open") {
    const existing = state.tabs.find((tab) => tab.id === action.tab.id);
    const tabs = !existing
      ? [...state.tabs, action.tab]
      : action.tab.sourceSessionId && existing.sourceSessionId !== action.tab.sourceSessionId
        ? state.tabs.map((tab) =>
            tab.id === action.tab.id ? { ...tab, sourceSessionId: action.tab.sourceSessionId } : tab,
          )
        : state.tabs;
    return { tabs, activeTabId: action.tab.id };
  }

  const closedIndex = state.tabs.findIndex((tab) => tab.id === action.tabId);
  if (closedIndex < 0) return state;
  const tabs = state.tabs.filter((tab) => tab.id !== action.tabId);
  if (state.activeTabId !== action.tabId) return { ...state, tabs };
  return {
    tabs,
    activeTabId: tabs.length > 0 ? tabs[tabs.length - 1].id : action.fallbackTabId,
  };
}
