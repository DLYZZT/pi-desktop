export interface RouterCompat {
  replace: (url: string, options?: { scroll?: boolean }) => void;
}

export const routerCompat: RouterCompat = Object.freeze({
  replace(url: string, _options?: { scroll?: boolean }) {
    const next = url.startsWith("?") || url.startsWith("/") ? url : `?${url}`;
    const full = next.startsWith("?") ? `${window.location.pathname}${next}` : next;
    window.history.replaceState(null, "", full === "/" ? "/" : full);
    window.dispatchEvent(new Event("popstate"));
  },
});

export function readSessionIdFromSearch(search: string): string | null {
  return new URLSearchParams(search).get("session");
}
