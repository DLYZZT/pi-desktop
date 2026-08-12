export interface TextFileData {
  content: string;
  language: string;
  size: number;
}

export type TextFileLoadState =
  | { status: "loading"; data: null; error: null; prevContent: null; changeCount: 0 }
  | { status: "error"; data: null; error: string; prevContent: null; changeCount: number }
  | { status: "ready"; data: TextFileData; error: null; prevContent: string | null; changeCount: number };

export type TextFileLoadAction =
  { type: "reset" } | { type: "failed"; error: string } | { type: "succeeded"; data: TextFileData; refresh: boolean };

export const INITIAL_TEXT_FILE_LOAD_STATE: TextFileLoadState = {
  status: "loading",
  data: null,
  error: null,
  prevContent: null,
  changeCount: 0,
};

export function textFileLoadReducer(state: TextFileLoadState, action: TextFileLoadAction): TextFileLoadState {
  switch (action.type) {
    case "reset":
      return INITIAL_TEXT_FILE_LOAD_STATE;
    case "failed":
      return {
        status: "error",
        data: null,
        error: action.error,
        prevContent: null,
        changeCount: state.changeCount,
      };
    case "succeeded":
      return {
        status: "ready",
        data: action.data,
        error: null,
        prevContent: action.refresh && state.status === "ready" ? state.data.content : null,
        changeCount: action.refresh ? state.changeCount + 1 : 0,
      };
    default:
      return state;
  }
}
